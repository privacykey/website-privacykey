# List available commands
default:
    @just --list

# Serve the static site locally
[group("dev")]
run:
    npx --yes wrangler@latest dev --assets .

# Deploy the site to Cloudflare
[group("deploy")]
deploy:
    npx --yes wrangler@latest deploy --assets . --name website-privacykey --compatibility-date 2026-05-01
