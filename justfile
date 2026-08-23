# List available commands
default:
    @just --list

# Serve the static site locally (reads wrangler.jsonc)
[group("dev")]
run:
    npx --yes wrangler@latest dev

# Deploy by hand. Normally Cloudflare Workers Builds does this on every push
# to main (Git integration); use this when that is broken or a change has to
# go out without a merge. Needs a logged-in wrangler (`npx wrangler login`).
[group("deploy")]
deploy:
    npx --yes wrangler@latest deploy
