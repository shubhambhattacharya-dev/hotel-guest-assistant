# Hotel Guest Assistant Frontend

Next.js and React guest-facing chat interface for the hotel assistant.

## Run Locally

From the repository root, start the backend first:

```bash
cd ../backend
npm install
npm run dev
```

Then start the frontend in another terminal:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The frontend calls the backend API only. Configure the API URL with `NEXT_PUBLIC_API_URL` when the backend is not running on `http://localhost:8000`.

See the repository-level `README.md` for the complete architecture, backend setup, API examples, testing, and evaluation results.
