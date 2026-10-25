default:
    @just --list

# Start the server with hot reload
dev:
    bun run dev

# Start the server in production mode
start:
    bun run start

test:
    bun test

typecheck:
    bun run typecheck

lint:
    bun run lint

fmt:
    bun run lint:fix

# Everything CI runs
ci: typecheck lint test
