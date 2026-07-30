package launch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/Doout/rowake/internal/server"
	"github.com/Doout/rowake/internal/service"
)

var Version = "dev"

type Config struct {
	Listen          string
	Version         string
	Logger          *slog.Logger
	ConnectionStore string
}

type RunningServer struct {
	URL      string
	HTTP     *http.Server
	Listener net.Listener

	cancel       context.CancelFunc
	errors       chan error
	service      *service.Service
	shutdownOnce sync.Once
	shutdownErr  error
}

func Start(parent context.Context, config Config) (*RunningServer, error) {
	if config.Listen == "" {
		config.Listen = "127.0.0.1:8080"
	}
	if config.Version == "" {
		config.Version = Version
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	appService := service.New(config.Version)
	if config.ConnectionStore != "" {
		if err := appService.EnablePersistence(parent, config.ConnectionStore); err != nil {
			config.Logger.Warn("some saved connections could not be restored", "error", err)
		}
	}
	handler, err := server.New(appService, config.Logger)
	if err != nil {
		_ = appService.Close()
		return nil, err
	}

	serverCtx, cancel := context.WithCancel(parent)
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(serverCtx, "tcp", config.Listen)
	if err != nil {
		cancel()
		_ = appService.Close()
		return nil, fmt.Errorf("listen on %s: %w", config.Listen, err)
	}

	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext: func(net.Listener) context.Context {
			return serverCtx
		},
	}
	running := &RunningServer{
		URL:      BrowserAddress(listener.Addr()),
		HTTP:     httpServer,
		Listener: listener,
		cancel:   cancel,
		errors:   make(chan error, 1),
		service:  appService,
	}
	go func() {
		err := httpServer.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		running.errors <- err
		close(running.errors)
	}()
	return running, nil
}

func (r *RunningServer) Errors() <-chan error {
	return r.errors
}

func (r *RunningServer) Shutdown(ctx context.Context) error {
	r.shutdownOnce.Do(func() {
		r.cancel()
		r.shutdownErr = r.HTTP.Shutdown(ctx)
		r.shutdownErr = errors.Join(r.shutdownErr, r.service.Close())
	})
	return r.shutdownErr
}

func BrowserAddress(address net.Addr) string {
	host, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return "http://" + address.String()
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}
