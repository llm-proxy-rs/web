```sh
black .
cd frontend/
npx prettier --write .
```
```sh
uv run --with pytest pytest rootfs/test_agent.py
```
```sh
cd frontend/
npx npm-check-updates -u
npm install
npm run build
npx playwright test
```
