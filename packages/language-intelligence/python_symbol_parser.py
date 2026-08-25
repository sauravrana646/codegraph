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


def _unique_calls(items: list[dict]) -> list[dict]:
    seen: set[tuple[str, int, str]] = set()
    out: list[dict] = []
    for item in items:
        name = item.get("name")
        line = item.get("line")
        if not name or not isinstance(line, int):
            continue
        receiver = item.get("receiver") if isinstance(item.get("receiver"), str) else None
        key = (name, line, receiver or "")
        if key in seen:
            continue
        seen.add(key)
        payload = {"name": name, "line": line}
        if receiver:
            payload["receiver"] = receiver
        out.append(payload)
    return out


def _call_name(func: ast.AST) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Call):
        return _call_name(func.func)
    return None


def _call_receiver(func: ast.AST) -> str | None:
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        return func.value.id
    if isinstance(func, ast.Call):
        return _call_receiver(func.func)
    return None


def _collect_calls(node: ast.AST) -> list[dict]:
    calls: list[dict] = []
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(child, ast.Call):
            name = _call_name(child.func)
            if name:
                payload = {"name": name, "line": child.lineno}
                receiver = _call_receiver(child.func)
                if receiver:
                    payload["receiver"] = receiver
                calls.append(payload)
        calls.extend(_collect_calls(child))
    return _unique_calls(calls)


def _signature(node: ast.AST) -> str:
    if isinstance(node, ast.ClassDef):
        return f"class {node.name}"
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        args: list[str] = []
        for arg in [*node.args.posonlyargs, *node.args.args]:
            args.append(arg.arg)
        if node.args.vararg:
            args.append(f"*{node.args.vararg.arg}")
        for arg in node.args.kwonlyargs:
            args.append(arg.arg)
        if node.args.kwarg:
            args.append(f"**{node.args.kwarg.arg}")
        return f"{prefix} {node.name}({', '.join(args)})"
    return ""


def _docstring(node: ast.AST) -> str | None:
    text = ast.get_docstring(node)
    if not text:
        return None
    compact = " ".join(text.split())
    return compact[:240]


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
                    "docstring": _docstring(item),
                    "calls": _collect_calls(item),
                    "signature": _signature(item),
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
        def __init__(self) -> None:
            self.class_stack: list[str] = []
            self.func_stack: list[str] = []

        def _function_symbol(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> dict:
            parent = self.class_stack[-1] if self.class_stack and not self.func_stack else None
            return {
                "name": node.name,
                "kind": "function",
                "line": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "indent": node.col_offset,
                "bases": [],
                "decorators": _decorator_names(node),
                "docstring": _docstring(node),
                "members": [],
                "signature": _signature(node),
                "calls": _collect_calls(node),
                "parentName": parent,
            }

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            symbols.append(self._function_symbol(node))
            self.func_stack.append(node.name)
            self.generic_visit(node)
            self.func_stack.pop()

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            symbols.append(self._function_symbol(node))
            self.func_stack.append(node.name)
            self.generic_visit(node)
            self.func_stack.pop()

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
                    "docstring": _docstring(node),
                    "members": _class_members(node),
                    "signature": _signature(node),
                    "calls": _collect_calls(node),
                    "parentName": None,
                }
            )
            self.class_stack.append(node.name)
            self.generic_visit(node)
            self.class_stack.pop()

    Visitor().visit(tree)
    module_calls = _collect_calls(tree)
    if module_calls:
        end_line = getattr(tree, "end_lineno", None) or max(
            (getattr(node, "end_lineno", getattr(node, "lineno", 1)) for node in tree.body),
            default=1,
        )
        symbols.append(
            {
                "name": "<module>",
                "kind": "function",
                "line": 1,
                "endLine": end_line,
                "indent": 0,
                "bases": [],
                "decorators": [],
                "docstring": None,
                "members": [],
                "signature": "<module>",
                "calls": module_calls,
                "parentName": None,
            }
        )
    return {"symbols": symbols, "imports": _imports(tree)}


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: python_symbol_parser.py <file_path>"}))
        sys.exit(1)

    result = parse_file(sys.argv[1])
    print(json.dumps(result))


if __name__ == "__main__":
    main()
