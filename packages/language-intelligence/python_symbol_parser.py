import ast
import json
import pathlib
import sys


def _unparse(node: ast.AST | None) -> str | None:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def _decorator_names(node: ast.AST) -> list[str]:
    decorators = getattr(node, "decorator_list", []) or []
    names: list[str] = []
    for decorator in decorators:
        text = _unparse(decorator)
        if text:
            names.append(text)
    return names


def _class_members(node: ast.ClassDef) -> list[dict]:
    members: list[dict] = []

    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            members.append(
                {
                    "kind": "method",
                    "name": item.name,
                    "line": item.lineno,
                    "endLine": getattr(item, "end_lineno", item.lineno),
                    "decorators": _decorator_names(item),
                    "docstring": ast.get_docstring(item),
                }
            )
            continue

        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            members.append(
                {
                    "kind": "field",
                    "name": item.target.id,
                    "line": item.lineno,
                    "endLine": getattr(item, "end_lineno", item.lineno),
                    "annotation": _unparse(item.annotation),
                    "value": _unparse(item.value),
                    "decorators": [],
                    "docstring": None,
                }
            )
            continue

        if isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name):
                    members.append(
                        {
                            "kind": "field",
                            "name": target.id,
                            "line": item.lineno,
                            "endLine": getattr(item, "end_lineno", item.lineno),
                            "annotation": None,
                            "value": _unparse(item.value),
                            "decorators": [],
                            "docstring": None,
                        }
                    )

    return members


def _imports(tree: ast.AST) -> list[dict]:
    imports: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(
                    {
                        "kind": "import",
                        "module": alias.name,
                        "names": [alias.asname or alias.name.split(".")[-1]],
                        "alias": alias.asname,
                        "line": node.lineno,
                    }
                )
            continue
        if isinstance(node, ast.ImportFrom):
            module = ("." * (node.level or 0)) + (node.module or "")
            imports.append(
                {
                    "kind": "from",
                    "module": module,
                    "names": [alias.name for alias in node.names],
                    "alias": None,
                    "line": node.lineno,
                }
            )
    return imports


def parse_file(file_path: str) -> dict:
    path = pathlib.Path(file_path)
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))

    symbols = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            symbols.append(
                {
                    "name": node.name,
                    "kind": "function",
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                    "indent": node.col_offset,
                    "bases": [],
                    "decorators": _decorator_names(node),
                    "docstring": ast.get_docstring(node),
                    "members": [],
                }
            )
            self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            symbols.append(
                {
                    "name": node.name,
                    "kind": "function",
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                    "indent": node.col_offset,
                    "bases": [],
                    "decorators": _decorator_names(node),
                    "docstring": ast.get_docstring(node),
                    "members": [],
                }
            )
            self.generic_visit(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            symbols.append(
                {
                    "name": node.name,
                    "kind": "class",
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno),
                    "indent": node.col_offset,
                    "bases": [text for base in node.bases if (text := _unparse(base))],
                    "decorators": _decorator_names(node),
                    "docstring": ast.get_docstring(node),
                    "members": _class_members(node),
                }
            )
            self.generic_visit(node)

    Visitor().visit(tree)
    return {"symbols": symbols, "imports": _imports(tree)}


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: python_symbol_parser.py <file_path>"}))
        sys.exit(1)

    result = parse_file(sys.argv[1])
    print(json.dumps(result))


if __name__ == "__main__":
    main()
