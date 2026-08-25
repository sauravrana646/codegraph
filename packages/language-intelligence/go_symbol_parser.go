// Codegraph Go symbol parser — emits the same JSON contract as python_symbol_parser.py.
// Usage: go_symbol_parser <file_path>
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

type callSite struct {
	Name     string `json:"name"`
	Line     int    `json:"line"`
	Receiver string `json:"receiver,omitempty"`
}

type member struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Line      int    `json:"line"`
	EndLine   int    `json:"endLine,omitempty"`
	Signature string `json:"signature,omitempty"`
	Docstring string `json:"docstring,omitempty"`
}

type symbol struct {
	Name       string     `json:"name"`
	Kind       string     `json:"kind"`
	Line       int        `json:"line"`
	EndLine    int        `json:"endLine"`
	Indent     int        `json:"indent"`
	Bases      []string   `json:"bases"`
	Decorators []string   `json:"decorators"`
	Docstring  *string    `json:"docstring"`
	Members    []member   `json:"members"`
	Signature  string     `json:"signature"`
	Calls      []callSite `json:"calls"`
	ParentName *string    `json:"parentName"`
}

type importItem struct {
	Kind   string   `json:"kind"`
	Module string   `json:"module"`
	Names  []string `json:"names"`
	Alias  *string  `json:"alias"`
	Line   int      `json:"line"`
}

type parseResult struct {
	Symbols []symbol     `json:"symbols"`
	Imports []importItem `json:"imports"`
	Package string       `json:"package,omitempty"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, `{"error":"usage: go_symbol_parser <file_path>"}`)
		os.Exit(1)
	}
	result, err := parseFile(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "encode error: %v\n", err)
		os.Exit(1)
	}
}

func parseFile(path string) (*parseResult, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return nil, err
	}

	out := &parseResult{
		Symbols: []symbol{},
		Imports: []importItem{},
		Package: file.Name.Name,
	}

	for _, imp := range file.Imports {
		module := strings.Trim(imp.Path.Value, `"`)
		alias := (*string)(nil)
		name := lastImportComponent(module)
		if imp.Name != nil {
			n := imp.Name.Name
			if n == "." || n == "_" {
				name = n
			} else {
				alias = &n
				name = n
			}
		}
		pos := fset.Position(imp.Pos())
		item := importItem{
			Kind:   "import",
			Module: module,
			Names:  []string{name},
			Alias:  alias,
			Line:   pos.Line,
		}
		out.Imports = append(out.Imports, item)
	}

	typeMembers := map[string][]member{}
	typeBases := map[string][]string{}

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			out.Symbols = append(out.Symbols, funcSymbol(fset, d))
		case *ast.GenDecl:
			if d.Tok == token.TYPE {
				for _, spec := range d.Specs {
					ts, ok := spec.(*ast.TypeSpec)
					if !ok {
						continue
					}
					start := fset.Position(ts.Pos()).Line
					end := fset.Position(ts.End()).Line
					bases := []string{}
					members := []member{}
					switch t := ts.Type.(type) {
					case *ast.InterfaceType:
						for _, field := range t.Methods.List {
							if len(field.Names) == 0 {
								if named := typeName(field.Type); named != "" {
									bases = append(bases, named)
								}
								continue
							}
							for _, name := range field.Names {
								members = append(members, member{
									Kind:      "method",
									Name:      name.Name,
									Line:      fset.Position(name.Pos()).Line,
									EndLine:   fset.Position(field.End()).Line,
									Signature: "func " + name.Name,
								})
							}
						}
					case *ast.StructType:
						for _, field := range t.Fields.List {
							if len(field.Names) == 0 {
								continue
							}
							for _, name := range field.Names {
								members = append(members, member{
									Kind:    "field",
									Name:    name.Name,
									Line:    fset.Position(name.Pos()).Line,
									EndLine: fset.Position(field.End()).Line,
								})
							}
						}
					}
					doc := commentText(d.Doc)
					if doc == nil {
						doc = commentText(ts.Doc)
					}
					sym := symbol{
						Name:       ts.Name.Name,
						Kind:       "class",
						Line:       start,
						EndLine:    end,
						Indent:     0,
						Bases:      bases,
						Decorators: []string{},
						Docstring:  doc,
						Members:    members,
						Signature:  "type " + ts.Name.Name,
						Calls:      []callSite{},
						ParentName: nil,
					}
					out.Symbols = append(out.Symbols, sym)
					typeMembers[ts.Name.Name] = members
					typeBases[ts.Name.Name] = bases
				}
			}
		}
	}

	// Attach method members onto matching type symbols when methods appear later.
	for i := range out.Symbols {
		sym := &out.Symbols[i]
		if sym.Kind != "class" {
			continue
		}
		for _, other := range out.Symbols {
			if other.Kind == "function" && other.ParentName != nil && *other.ParentName == sym.Name {
				sym.Members = append(sym.Members, member{
					Kind:      "method",
					Name:      other.Name,
					Line:      other.Line,
					EndLine:   other.EndLine,
					Signature: other.Signature,
				})
				if other.Line < sym.Line {
					sym.Line = other.Line
				}
				if other.EndLine > sym.EndLine {
					sym.EndLine = other.EndLine
				}
			}
		}
	}

	moduleCalls := collectFileCalls(fset, file)
	if len(moduleCalls) > 0 {
		end := 1
		if file.End().IsValid() {
			end = fset.Position(file.End()).Line
		}
		out.Symbols = append(out.Symbols, symbol{
			Name:       "<module>",
			Kind:       "function",
			Line:       1,
			EndLine:    end,
			Indent:     0,
			Bases:      []string{},
			Decorators: []string{},
			Docstring:  nil,
			Members:    []member{},
			Signature:  "<module>",
			Calls:      moduleCalls,
			ParentName: nil,
		})
	}

	_ = typeMembers
	_ = typeBases
	return out, nil
}

func funcSymbol(fset *token.FileSet, fn *ast.FuncDecl) symbol {
	start := fset.Position(fn.Pos()).Line
	end := fset.Position(fn.End()).Line
	var parent *string
	recvName := ""
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		recvName = receiverTypeName(fn.Recv.List[0].Type)
		if recvName != "" {
			parent = &recvName
		}
	}
	sig := "func "
	if parent != nil {
		sig += "(" + recvName + ") "
	}
	sig += fn.Name.Name + "()"
	doc := commentText(fn.Doc)
	return symbol{
		Name:       fn.Name.Name,
		Kind:       "function",
		Line:       start,
		EndLine:    end,
		Indent:     0,
		Bases:      []string{},
		Decorators: []string{},
		Docstring:  doc,
		Members:    []member{},
		Signature:  sig,
		Calls:      collectCalls(fset, fn.Body),
		ParentName: parent,
	}
}

func receiverTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return receiverTypeName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return receiverTypeName(t.X)
	case *ast.IndexListExpr:
		return receiverTypeName(t.X)
	case *ast.SelectorExpr:
		return t.Sel.Name
	default:
		return ""
	}
}

func typeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.StarExpr:
		return typeName(t.X)
	default:
		return ""
	}
}

func commentText(group *ast.CommentGroup) *string {
	if group == nil {
		return nil
	}
	text := strings.TrimSpace(group.Text())
	if text == "" {
		return nil
	}
	compact := strings.Join(strings.Fields(text), " ")
	if len(compact) > 240 {
		compact = compact[:240]
	}
	return &compact
}

func collectCalls(fset *token.FileSet, body *ast.BlockStmt) []callSite {
	if body == nil {
		return []callSite{}
	}
	var calls []callSite
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		name, receiver := callNameReceiver(call.Fun)
		if name == "" {
			return true
		}
		calls = append(calls, callSite{
			Name:     name,
			Line:     fset.Position(call.Pos()).Line,
			Receiver: receiver,
		})
		return true
	})
	return uniqueCalls(calls)
}

func collectFileCalls(fset *token.FileSet, file *ast.File) []callSite {
	var calls []callSite
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.VAR {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, value := range vs.Values {
				ast.Inspect(value, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					name, receiver := callNameReceiver(call.Fun)
					if name == "" {
						return true
					}
					calls = append(calls, callSite{
						Name:     name,
						Line:     fset.Position(call.Pos()).Line,
						Receiver: receiver,
					})
					return true
				})
			}
		}
	}
	return uniqueCalls(calls)
}

func callNameReceiver(fun ast.Expr) (name string, receiver string) {
	switch t := fun.(type) {
	case *ast.Ident:
		return t.Name, ""
	case *ast.SelectorExpr:
		recv := ""
		if id, ok := t.X.(*ast.Ident); ok {
			recv = id.Name
		}
		return t.Sel.Name, recv
	case *ast.CallExpr:
		return callNameReceiver(t.Fun)
	default:
		return "", ""
	}
}

func uniqueCalls(items []callSite) []callSite {
	seen := map[string]struct{}{}
	out := make([]callSite, 0, len(items))
	for _, item := range items {
		key := fmt.Sprintf("%s:%d:%s", item.Name, item.Line, item.Receiver)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

func lastImportComponent(module string) string {
	if module == "" {
		return module
	}
	parts := strings.Split(module, "/")
	return parts[len(parts)-1]
}
