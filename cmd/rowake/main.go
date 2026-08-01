package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/Doout/rowake/internal/db"
	"github.com/Doout/rowake/internal/launch"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "rowake:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "open"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}
	switch command {
	case "open":
		return runServer(args, "127.0.0.1:8080", true)
	case "serve":
		return runServer(args, "0.0.0.0:8080", false)
	case "version", "--version", "-version":
		fmt.Printf("Rowake %s\ncommit: %s\nbuilt: %s\ndrivers: %s\n", version, commit, buildDate, compiledDriverNames())
		return nil
	case "drivers":
		for _, driver := range db.Compiled() {
			fmt.Printf("%s\t%s\t%s\n", driver.Engine, driver.DatabaseSQLName, driver.DisplayName)
		}
		return nil
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func runServer(args []string, defaultListen string, defaultOpen bool) error {
	flags := flag.NewFlagSet("rowake", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	listen := flags.String("listen", defaultListen, "HTTP listen address")
	open := flags.Bool("open", defaultOpen, "open Rowake in the default browser")
	accessToken := flags.String("access-token", os.Getenv("ROWAKE_ACCESS_TOKEN"), "access token required by non-loopback server mode")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if requiresAccessToken(*listen) && strings.TrimSpace(*accessToken) == "" {
		return errors.New("non-loopback server mode requires --access-token or ROWAKE_ACCESS_TOKEN")
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	running, err := launch.Start(ctx, launch.Config{
		Listen:      *listen,
		Version:     version,
		Logger:      logger,
		AccessToken: strings.TrimSpace(*accessToken),
	})
	if err != nil {
		return err
	}

	logger.Info("Rowake is listening", "url", running.URL, "version", version)
	if *open {
		go func() {
			time.Sleep(180 * time.Millisecond)
			if err := openBrowser(running.URL); err != nil {
				logger.Warn("could not open browser", "error", err)
			}
		}()
	}
	select {
	case err := <-running.Errors():
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return running.Shutdown(shutdownCtx)
	}
}

func requiresAccessToken(listen string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(listen))
	if err != nil {
		return true
	}
	host = strings.Trim(host, "[]")
	return host != "127.0.0.1" && host != "::1" && !strings.EqualFold(host, "localhost")
}

func openBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	return command.Start()
}

func compiledDriverNames() string {
	drivers := db.Compiled()
	names := make([]string, 0, len(drivers))
	for _, driver := range drivers {
		names = append(names, driver.DisplayName)
	}
	return strings.Join(names, ", ")
}

func printUsage() {
	fmt.Print(`Rowake database viewer

Usage:
  rowake open    [--listen 127.0.0.1:8080]
  rowake serve   [--listen 0.0.0.0:8080] [--access-token TOKEN] [--open]
  rowake drivers
  rowake version

Every standard Rowake build includes SQLite, PostgreSQL, and MySQL/MariaDB
drivers.
`)
}
