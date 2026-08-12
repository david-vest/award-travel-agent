.PHONY: setup seed dev record eval test down

setup:
	npm install
	docker compose up -d
	@echo "Waiting for MongoDB to accept connections..."
	@until docker compose exec -T mongodb mongosh --quiet --eval "db.runCommand({ping:1})" >/dev/null 2>&1; do sleep 1; done
	@echo "MongoDB ready."

seed:
	npm run seed

dev:
	npm run dev

record:
	npm run record

eval:
	npm run eval

test:
	npm run typecheck && npm test

down:
	docker compose down
