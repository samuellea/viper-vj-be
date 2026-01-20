require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`, {
    body: req.body,
    query: req.query,
    params: req.params
  });
  next();
});

// Initialize Firebase Admin
let db;
try {
  let serviceAccount;
  
  // Try to load from environment variable first (for Render/deployment)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log('Loading Firebase service account from FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (parseError) {
      throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ${parseError.message}`);
    }
  } else {
    // Fall back to file path (for local development)
    const serviceAccountPath = path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '../viper-js-firebase-adminsdk.json');
    console.log('Loading Firebase service account from file:', serviceAccountPath);
    
    if (!fs.existsSync(serviceAccountPath)) {
      throw new Error(`Firebase service account file not found at: ${serviceAccountPath}. Either set FIREBASE_SERVICE_ACCOUNT_JSON environment variable or ensure the file exists.`);
    }
    
    serviceAccount = require(serviceAccountPath);
  }
  
  // Validate service account has required fields
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Invalid Firebase service account. Missing required fields (project_id, private_key, or client_email).');
  }
  
  const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://viper-vj-default-rtdb.europe-west1.firebasedatabase.app';
  console.log('Initializing Firebase Admin with database URL:', databaseURL);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: databaseURL
  });
  
  db = admin.database();
  console.log('Firebase Admin initialized successfully');
  
  // Test database access with a simple read operation
  // Note: Admin SDK doesn't maintain persistent connections like client SDK
  // The .info/connected check doesn't work the same way
  try {
    const testRef = db.ref('.info/serverTimeOffset');
    testRef.once('value', () => {
      console.log('✓ Database access verified - can read from Firebase');
    }).catch((err) => {
      console.error('✗ ERROR: Cannot access Firebase database:', err.message);
      console.error('Please verify:');
      console.error('1. Database URL is correct:', databaseURL);
      console.error('2. Realtime Database is enabled in Firebase Console');
      console.error('3. Database exists for project:', serviceAccount.project_id);
      console.error('4. Service account has proper permissions');
      console.error('5. Database rules allow admin access (Admin SDK bypasses rules)');
    });
  } catch (err) {
    console.error('Error setting up database connection test:', err);
  }
  
  // Suppress the Firebase warning about .info/connected - it's normal for Admin SDK
  console.log('Note: Firebase Admin SDK warnings about .info/connected are normal and can be ignored.');
  
} catch (error) {
  console.error('FATAL ERROR: Failed to initialize Firebase Admin:', error);
  console.error('Error details:', {
    message: error.message,
    stack: error.stack,
    hasEnvVar: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '../viper-js-firebase-adminsdk.json'
  });
  console.error('\nTo fix this:');
  console.error('1. For deployment (Render): Set FIREBASE_SERVICE_ACCOUNT_JSON environment variable with the full JSON content');
  console.error('2. For local development: Ensure viper-js-firebase-adminsdk.json exists in the project root');
  process.exit(1);
}

// Helper functions to encode/decode usernames for Firebase paths
// Firebase Realtime Database paths cannot contain: ".", "#", "$", "[", "]"
function encodeUsernameForFirebase(username) {
  if (!username) return username;
  return username
    .replace(/\./g, '_DOT_')
    .replace(/@/g, '_AT_')
    .replace(/#/g, '_HASH_')
    .replace(/\$/g, '_DOLLAR_')
    .replace(/\[/g, '_LBRACKET_')
    .replace(/\]/g, '_RBRACKET_');
}

function decodeUsernameFromFirebase(encodedUsername) {
  if (!encodedUsername) return encodedUsername;
  return encodedUsername
    .replace(/_DOT_/g, '.')
    .replace(/_AT_/g, '@')
    .replace(/_HASH_/g, '#')
    .replace(/_DOLLAR_/g, '$')
    .replace(/_LBRACKET_/g, '[')
    .replace(/_RBRACKET_/g, ']');
}

// Helper function to fetch YouTube video title
async function getYouTubeVideoTitle(videoId) {
  try {
    const response = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      timeout: 5000
    });
    return response.data.title || 'Untitled Video';
  } catch (error) {
    console.warn(`Could not fetch title for video ${videoId}:`, error.message);
    return 'Untitled Video';
  }
}

// POST /videos - Save video with hotcues
app.post('/videos', async (req, res) => {
  try {
    console.log('POST /videos - Request received');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { youtubeUrl, videoId, hotcues, username } = req.body;

    // Validation
    if (!youtubeUrl || !videoId) {
      const missingFields = [];
      if (!youtubeUrl) missingFields.push('youtubeUrl');
      if (!videoId) missingFields.push('videoId');
      
      console.error('Validation error: Missing required fields:', missingFields);
      return res.status(400).json({ 
        error: 'Missing required fields',
        missingFields: missingFields,
        received: { youtubeUrl: !!youtubeUrl, videoId: !!videoId, hotcues: !!hotcues }
      });
    }

    // Validate username
    if (!username) {
      console.error('Validation error: Missing username');
      return res.status(400).json({ 
        error: 'Missing required field: username',
        details: 'Username is required to save videos'
      });
    }

    // Validate hotcues format
    if (hotcues && typeof hotcues !== 'object') {
      console.error('Validation error: hotcues must be an object');
      return res.status(400).json({ 
        error: 'Invalid hotcues format',
        details: 'hotcues must be an object'
      });
    }

    // Fetch video title from YouTube
    console.log('Fetching video title for:', videoId);
    const title = await getYouTubeVideoTitle(videoId);
    console.log('Video title:', title);

    // Encode username for Firebase path (Firebase paths cannot contain ".", "#", "$", "[", "]")
    const encodedUsername = encodeUsernameForFirebase(username);
    
    // Check if video already exists to preserve createdAt
    const videoRef = db.ref(`users/${encodedUsername}/videos/${videoId}`);
    const existingSnapshot = await videoRef.once('value');
    const existingVideo = existingSnapshot.exists() ? existingSnapshot.val() : null;
    
    // Create video data object
    const videoData = {
      youtubeUrl,
      videoId,
      title,
      username: username, // Always store original username with video for reference
      hotcues: hotcues || {},
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };
    
    // Only set createdAt if this is a new video
    if (!existingVideo || !existingVideo.createdAt) {
      videoData.createdAt = admin.database.ServerValue.TIMESTAMP;
    } else {
      // Preserve existing createdAt
      videoData.createdAt = existingVideo.createdAt;
      // Ensure username is always set, even for existing videos
      videoData.username = username;
    }

    console.log('Saving to Firebase:', {
      path: `users/${encodedUsername}/videos/${videoId}`,
      encodedUsername: encodedUsername,
      originalUsername: username,
      isNewVideo: !existingVideo,
      data: { ...videoData, createdAt: existingVideo?.createdAt || 'SERVER_VALUE', updatedAt: 'SERVER_VALUE' }
    });

    // Save to Firebase Realtime Database under user's videos
    // Store at /users/{username}/videos/{videoId}
    
    try {
      await videoRef.set(videoData);
      console.log('Successfully saved to Firebase');
      
      res.json({ 
        success: true, 
        message: 'Video saved successfully',
        videoId,
        savedAt: new Date().toISOString()
      });
    } catch (firebaseError) {
      console.error('Firebase error:', firebaseError);
      console.error('Firebase error details:', {
        code: firebaseError.code,
        message: firebaseError.message,
        stack: firebaseError.stack
      });
      
      res.status(500).json({ 
        error: 'Failed to save to Firebase Realtime Database',
        details: firebaseError.message,
        code: firebaseError.code || 'UNKNOWN',
        type: 'FIREBASE_ERROR'
      });
    }
  } catch (error) {
    console.error('Unexpected error saving video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      type: 'SERVER_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET /videos - Get videos for a specific user
app.get('/videos', async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username) {
      console.error('GET /videos - Missing username query parameter');
      return res.status(400).json({ 
        error: 'Missing required query parameter: username',
        details: 'Username is required to fetch videos'
      });
    }

    console.log(`GET /videos - Fetching videos for user: ${username}`);
    
    // Encode username for Firebase path (Firebase paths cannot contain ".", "#", "$", "[", "]")
    const encodedUsername = encodeUsernameForFirebase(username);
    
    // Fetch videos for the specific user
    const videosRef = db.ref(`users/${encodedUsername}/videos`);
    const snapshot = await videosRef.once('value');
    
    if (!snapshot.exists()) {
      console.log(`No videos found for user: ${username} (encoded: ${encodedUsername})`);
      return res.json([]);
    }

    const videos = snapshot.val();
    // Convert object to array with videoId included
    const videosArray = Object.keys(videos).map(videoId => ({
      videoId,
      ...videos[videoId]
    }));

    // Sort by createdAt (most recent first)
    videosArray.sort((a, b) => {
      const aTime = a.createdAt || a.updatedAt || 0;
      const bTime = b.createdAt || b.updatedAt || 0;
      return bTime - aTime; // Most recent first (descending order)
    });

    console.log(`Found ${videosArray.length} videos for user: ${username}`);
    res.json(videosArray);
  } catch (error) {
    console.error('Error fetching videos:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to fetch videos',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// GET /videos/:videoId - Get video with hotcues
app.get('/videos/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log('GET /videos/:videoId - Request for videoId:', videoId);
    
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.once('value');
    
    if (!snapshot.exists()) {
      console.log('Video not found:', videoId);
      return res.status(404).json({ 
        error: 'Video not found',
        videoId 
      });
    }

    console.log('Video found:', videoId);
    res.json(snapshot.val());
  } catch (error) {
    console.error('Error fetching video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to fetch video',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// DELETE /videos/:videoId - Delete a video
app.delete('/videos/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const { username } = req.query;
    
    console.log('DELETE /videos/:videoId - Request to delete videoId:', videoId);
    console.log('Request query:', req.query);

    if (!username) {
      console.error('DELETE /videos/:videoId - Missing username query parameter');
      return res.status(400).json({ 
        error: 'Missing required query parameter: username',
        details: 'Username is required to delete videos'
      });
    }
    
    // Encode username for Firebase path (Firebase paths cannot contain ".", "#", "$", "[", "]")
    const encodedUsername = encodeUsernameForFirebase(username);
    
    const videoRef = db.ref(`users/${encodedUsername}/videos/${videoId}`);
    const snapshot = await videoRef.once('value');
    
    if (!snapshot.exists()) {
      console.log(`Video not found for user ${username} (encoded: ${encodedUsername}) for deletion:`, videoId);
      return res.status(404).json({ 
        error: 'Video not found',
        videoId 
      });
    }

    // Delete the video
    await videoRef.remove();
    console.log(`Video deleted successfully for user ${username} (encoded: ${encodedUsername}):`, videoId);
    
    res.json({ 
      success: true, 
      message: 'Video deleted successfully',
      videoId 
    });
  } catch (error) {
    console.error('Error deleting video:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to delete video',
      details: error.message,
      type: 'FIREBASE_ERROR',
      code: error.code || 'UNKNOWN'
    });
  }
});

// POST /signup - Create a new user
app.post('/signup', async (req, res) => {
  try {
    console.log('POST /signup - Request received');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      const missingFields = [];
      if (!username) missingFields.push('username');
      if (!password) missingFields.push('password');
      
      console.error('Validation error: Missing required fields:', missingFields);
      return res.status(400).json({ 
        error: 'Missing required fields',
        missingFields: missingFields
      });
    }

    // Validate username format (alphanumeric and underscores, 3-20 chars)
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ 
        error: 'Invalid username format',
        details: 'Username must be 3-20 characters and contain only letters, numbers, and underscores'
      });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'Invalid password',
        details: 'Password must be at least 6 characters long'
      });
    }

    // Encode username for Firebase path (Firebase paths cannot contain ".", "#", "$", "[", "]")
    const encodedUsername = encodeUsernameForFirebase(username);
    
    // Check if username already exists by checking the encoded path
    const userRef = db.ref(`users/${encodedUsername}`);
    const existingUserSnapshot = await userRef.once('value');
    
    if (existingUserSnapshot.exists()) {
      console.warn(`Signup attempt with existing username: ${username} (encoded: ${encodedUsername})`);
      return res.status(409).json({ 
        error: 'Username already taken',
        type: 'USERNAME_EXISTS'
      });
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user object
    const userData = {
      username: username, // Store original username in the data
      password: hashedPassword, // Store hashed password, never plain text
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };

    // Save to Firebase Realtime Database at /users/{encodedUsername}
    await userRef.set(userData);

    console.log('User created successfully:', username);
    res.status(201).json({ 
      success: true, 
      message: 'User created successfully',
      username: username
    });
  } catch (error) {
    console.error('Unexpected error creating user:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      type: 'SERVER_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message,
    type: 'UNHANDLED_ERROR'
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log('Environment:', {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: PORT,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || 'https://viper-vj-default-rtdb.europe-west1.firebasedatabase.app'
  });
});
