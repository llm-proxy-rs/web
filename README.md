```sh
black .
cd frontend/
npx prettier --write .
```
```sh
cd frontend/
npx npm-check-updates -u
npm install
```
```sh
uv run --with pytest pytest rootfs/test_agent.py
cd frontend/
npm run build
npx playwright test
```
