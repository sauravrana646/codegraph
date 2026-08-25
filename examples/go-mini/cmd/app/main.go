package main

import "example.com/demo/internal/server"

func main() {
	svc := &server.Server{Name: "demo"}
	_ = svc.Handle()
}
