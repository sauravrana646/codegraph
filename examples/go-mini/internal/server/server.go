package server

import "example.com/demo/internal/util"

// Server handles demo requests.
type Server struct {
	Name string
}

// Handle greets through util.Helper and logs the result.
func (s *Server) Handle() string {
	msg := util.Helper(s.Name)
	s.log(msg)
	return msg
}

func (s *Server) log(msg string) {
	_ = msg
}
