package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Doout/rowake/internal/launch"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed frontend/dist/*
var embedded embed.FS

type desktopShell struct {
	server       *launch.RunningServer
	cancel       context.CancelFunc
	navigateOnce sync.Once
}

func (d *desktopShell) domReady(ctx context.Context) {
	d.navigateOnce.Do(func() {
		wailsruntime.WindowExecJS(ctx, fmt.Sprintf("window.location.replace(%q)", d.server.URL))
	})
}

func (d *desktopShell) shutdown(parent context.Context) {
	d.cancel()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), time.Second)
	defer cancel()
	_ = d.server.Shutdown(ctx)
}

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(launch.Version)
		return
	}
	if bindingGeneration {
		if err := wails.Run(&options.App{}); err != nil {
			log.Fatal(err)
		}
		return
	}

	assets, err := fs.Sub(embedded, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	serverCtx, cancel := context.WithCancel(context.Background())
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		cancel()
		log.Fatal(err)
	}
	running, err := launch.Start(serverCtx, launch.Config{
		Listen:          "127.0.0.1:0",
		Version:         launch.Version,
		Logger:          slog.New(slog.NewTextHandler(os.Stderr, nil)),
		ConnectionStore: filepath.Join(configDirectory, "Rowake", "connections.json"),
	})
	if err != nil {
		cancel()
		log.Fatal(err)
	}

	shell := &desktopShell{server: running, cancel: cancel}
	if err := wails.Run(&options.App{
		Title:                    "Rowake",
		Width:                    1280,
		Height:                   800,
		MinWidth:                 900,
		MinHeight:                600,
		BackgroundColour:         &options.RGBA{R: 12, G: 15, B: 19, A: 255},
		AssetServer:              &assetserver.Options{Assets: assets},
		OnDomReady:               shell.domReady,
		OnShutdown:               shell.shutdown,
		EnableDefaultContextMenu: false,
	}); err != nil {
		shell.shutdown(context.Background())
		log.Fatal(err)
	}
}
