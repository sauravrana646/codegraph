import ast
import json
import pathlib
import sys


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
                }
            )
            self.generic_visit(node)

    Visitor().visit(tree)
    return {"symbols": symbols}


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: python_symbol_parser.py <file_path>"}))
        sys.exit(1)

    result = parse_file(sys.argv[1])
    print(json.dumps(result))


if __name__ == "__main__":
    main()
