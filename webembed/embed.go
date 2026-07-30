package webembed

import "embed"

// Dist contains the dependency-free browser interface.
//
//go:embed dist/*
var Dist embed.FS
