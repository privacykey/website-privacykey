# List available commands
default:
    @just --list

# Serve the static site locally with Wrangler
[group("dev")]
run:
    npx --yes wrangler pages dev .
