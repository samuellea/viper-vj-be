# Viper Soundboard Backend

Backend API server for saving YouTube videos and hotcues to Firebase Realtime Database.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the `be` directory with:
```
FIREBASE_SERVICE_ACCOUNT_PATH=../viper-js-firebase-adminsdk.json
FIREBASE_DATABASE_URL=https://viper-vj.firebaseio.com
PORT=3001
```

3. Ensure `viper-js-firebase-adminsdk.json` is in the root directory (one level up from `be`)

4. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

## API Endpoints

### POST /videos
Save a video with hotcues.

Request body:
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=...",
  "videoId": "dQw4w9WgXcQ",
  "hotcues": {
    "q": 12.5,
    "w": 45.2
  }
}
```

### GET /videos/:videoId
Retrieve a saved video with hotcues.

### GET /health
Health check endpoint.
