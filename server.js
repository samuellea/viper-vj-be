require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
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
  // Load Firebase credentials from environment variables (required)
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  
  // Check for required environment variables
  const missingVars = [];
  if (!projectId) missingVars.push('FIREBASE_PROJECT_ID');
  if (!privateKey) missingVars.push('FIREBASE_PRIVATE_KEY');
  if (!clientEmail) missingVars.push('FIREBASE_CLIENT_EMAIL');
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required Firebase environment variables: ${missingVars.join(', ')}\n\nPlease set these in your .env file (local) or Render environment variables (deployment).`);
  }
  
  console.log('Loading Firebase service account from environment variables');
  console.log('Firebase Project ID:', projectId);
  console.log('Firebase Client Email:', clientEmail);
  
  // Build service account object from environment variables
  const serviceAccount = {
    type: "service_account",
    project_id: projectId,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || '',
    private_key: privateKey.replace(/\\n/g, '\n'), // Replace escaped newlines with actual newlines
    client_email: clientEmail,
    client_id: process.env.FIREBASE_CLIENT_ID || '',
    auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
    token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL || '',
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
  };
  
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
    stack: error.stack
  });
  console.error('\nTo fix this:');
  console.error('Set these REQUIRED environment variables:');
  console.error('   - FIREBASE_PROJECT_ID');
  console.error('   - FIREBASE_PRIVATE_KEY (full key with BEGIN/END lines, or with \\n for newlines)');
  console.error('   - FIREBASE_CLIENT_EMAIL');
  console.error('\nOptional environment variables:');
  console.error('   - FIREBASE_PRIVATE_KEY_ID');
  console.error('   - FIREBASE_CLIENT_ID');
  console.error('   - FIREBASE_CLIENT_X509_CERT_URL');
  console.error('   - FIREBASE_DATABASE_URL (defaults to viper-vj database)');
  console.error('\nFor local development: Create a .env file in the /be directory with these variables');
  console.error('For deployment (Render): Set these in Render dashboard > Environment Variables');
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

// POST /login - Authenticate a user
app.post('/login', async (req, res) => {
  try {
    console.log('POST /login - Request received');
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'Username and password are required'
      });
    }

    // Encode username for Firebase path
    const encodedUsername = encodeUsernameForFirebase(username);
    
    // Check if user exists
    const userRef = db.ref(`users/${encodedUsername}`);
    const userSnapshot = await userRef.once('value');
    
    if (!userSnapshot.exists()) {
      console.warn(`Login attempt with non-existent username: ${username} (encoded: ${encodedUsername})`);
      return res.status(401).json({ 
        error: 'No account exists for this user. Please try again!',
        type: 'USER_NOT_FOUND'
      });
    }

    const userData = userSnapshot.val();
    
    // Verify password
    const passwordMatch = await bcrypt.compare(password, userData.password);
    
    if (!passwordMatch) {
      console.warn(`Login attempt with incorrect password for username: ${username}`);
      return res.status(401).json({ 
        error: 'Invalid password. Please try again!',
        type: 'INVALID_PASSWORD'
      });
    }

    // Login successful
    console.log('Login successful for user:', username);
    res.json({ 
      success: true, 
      message: 'Login successful',
      username: username
    });
  } catch (error) {
    console.error('Unexpected error during login:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      type: 'SERVER_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
