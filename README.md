```sh
black .
uv run --with pytest pytest rootfs/test_agent.py
```
```sh
cd frontend/
npx prettier --write .
npx npm-check-updates -u
npm install
npm run build
npx playwright install
npx playwright test
```
