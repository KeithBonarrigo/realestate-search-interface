/**
 * =============================================================================
 * REAL ESTATE SEARCH INTERFACE - MAIN SERVER FILE (index.js)
 * =============================================================================
 *
 * This is the main entry point for the MLS (Multiple Listing Service) property
 * search application. It serves as a backend API that:
 *
 * 1. Connects to a PostgreSQL database containing MLS property listings
 * 2. Uses Redis for session management and caching
 * 3. Provides REST API endpoints for property searches
 * 4. Serves the frontend HTML interface
 *
 * ARCHITECTURE OVERVIEW:
 * ----------------------
 * [Client Browser] <---> [Express Server (this file)]
 *                              |
 *                              ├── [PostgreSQL DB] - Stores property listings
 *                              ├── [Redis] - Session/cache management
 *                              └── [Spark API] - External MLS photo/tour data
 *
 * FILE DEPENDENCIES:
 * - routes/db.js: Database utility functions for formatting listings
 * - form.html: Frontend user interface
 * - public/styles.css: CSS styling
 * =============================================================================
 */

// =============================================================================
// DEPENDENCY IMPORTS
// =============================================================================

const express = require('express');           // Web framework for Node.js
const session = require('express-session');   // Session middleware for user sessions
const RedisStore = require('connect-redis').default; // Redis-backed session storage
const redis = require('redis');               // Redis client for caching
const cors = require('cors');                 // Cross-Origin Resource Sharing middleware

require('dotenv').config();                   // Load environment variables from .env file

const bodyParser = require('body-parser');    // Parse incoming request bodies
const { Client } = require('pg');             // PostgreSQL client for database queries
const path = require('path');                 // File path utilities
const fs = require('fs');                     // File system operations

// =============================================================================
// ENVIRONMENT MODE DETECTION (Early - needed for Redis setup)
// =============================================================================
/**
 * Check if we're running in local mode EARLY so we can conditionally
 * set up Redis. In local mode, Redis is optional.
 */
const isLocalMode = process.env.MODE === 'LOCAL';
console.log(`-------✅ Running in ${isLocalMode ? 'LOCAL' : 'PRODUCTION'} mode`);

/**
 * Import formatting functions from the database module (routes/db.js)
 * These functions transform raw database results into usable formats:
 * - formatListings: Basic HTML formatting
 * - formatListingsMap: Includes map data with listings
 * - formatListingsRaw: Returns JSON with photos/tours attached
 */
const {
    formatListings,
    formatListingsMap,
    formatListingsRaw
  } = require('./routes/db');

// Initialize Express application
const app = express();

console.log("-------✅ IN index.js - setting up session ----------------------");

// =============================================================================
// REDIS CLIENT CONFIGURATION (Optional in Local Mode)
// =============================================================================
/**
 * Redis is used for:
 * 1. Session storage - Keeps user sessions persistent across server restarts
 * 2. Caching (optional) - Can cache property queries to reduce database load
 *
 * In LOCAL mode, Redis is OPTIONAL - the app will use in-memory sessions instead.
 * In PRODUCTION mode, Redis is REQUIRED for proper session management.
 *
 * Connection uses TLS for secure communication with hosted Redis (e.g., Heroku Redis)
 */
let redisClient = null;

if (!isLocalMode && process.env.REDIS_URL) {
    // Production mode with Redis configured: Connect to Redis with TLS
    redisClient = redis.createClient({
        url: process.env.REDIS_URL,      // Redis connection URL from environment
        socket: {
            tls: true,                    // Enable TLS encryption
            rejectUnauthorized: false     // Allow self-signed certificates (common for hosted Redis)
        }
    });
} else if (!isLocalMode) {
    console.log('-------⚠️ PRODUCTION MODE: REDIS_URL not set, using in-memory sessions');
} else {
    console.log('-------⚠️ LOCAL MODE: Skipping Redis (using in-memory sessions)');
}

// =============================================================================
// SESSION MIDDLEWARE CONFIGURATION
// =============================================================================
/**
 * Express session configuration.
 * - PRODUCTION: Uses Redis as the session store for persistence
 * - LOCAL: Uses in-memory sessions (sessions lost on server restart)
 *
 * Sessions are used to:
 * - Store user search preferences
 * - Cache listing results between page loads
 * - Maintain state across requests
 */
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'fallbackSecret',  // Secret for signing session ID
    resave: false,                    // Don't save session if unmodified
    saveUninitialized: false,         // Don't create session until something is stored
    cookie: {
        secure: !isLocalMode && process.env.NODE_ENV === 'production',  // HTTPS only in production
        httpOnly: true,               // Prevents client-side JS from reading cookie
        sameSite: isLocalMode ? "Lax" : "None"  // Lax for local, None for cross-origin in production
    }
};

// Only use Redis store in production mode
if (!isLocalMode && redisClient) {
    sessionConfig.store = new RedisStore({ client: redisClient });
}

app.use(session(sessionConfig));


// =============================================================================
// REQUEST PARSING MIDDLEWARE
// =============================================================================
/**
 * These middlewares parse incoming request bodies:
 * - express.json(): Parses JSON payloads (Content-Type: application/json)
 * - express.urlencoded(): Parses URL-encoded form data
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// CORS (Cross-Origin Resource Sharing) CONFIGURATION
// =============================================================================
/**
 * CORS controls which external domains can access this API.
 * This is essential for security when the frontend is hosted separately.
 *
 * Allowed origins:
 * - localhost:3000: Local development
 * - Heroku app URL: Production deployment
 */
console.log("-------✅ IN index.js - setting up cors ----------------------");

const allowedOrigins = [
    "http://localhost:3000",
    "https://mls-search-interface-dev-4a1699aed50b.herokuapp.com"
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("CORS policy does not allow this origin"));
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true  // Allow cookies to be sent with requests
}));

/**
 * Handle preflight OPTIONS requests
 * Browsers send OPTIONS requests before actual requests to check CORS permissions
 */
app.options("*", (req, res) => {
    res.header("Access-Control-Allow-Origin", "http://localhost:3000");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");
    res.status(204).end();
});

app.use(bodyParser.urlencoded({ extended: true }));

// =============================================================================
// API TOKEN AUTHENTICATION MIDDLEWARE
// =============================================================================
/**
 * Security middleware that validates API tokens for protected endpoints.
 * Tokens can be provided via:
 * - Authorization header: "Bearer <token>"
 * - Custom header: "x-api-token: <token>"
 *
 * This prevents unauthorized access to the search API.
 */
const validateToken = (req, res, next) => {
    const token = req.headers['authorization']?.replace('Bearer ', '')
                  || req.headers['x-api-token'];

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'No API token provided'
        });
    }

    if (token !== process.env.MLS_API_TOKEN) {
        return res.status(403).json({
            success: false,
            message: 'Invalid API token'
        });
    }

    next();  // Token is valid, proceed to the route handler
};

// =============================================================================
// STATIC FILE SERVING
// =============================================================================
/**
 * Serve static assets (CSS, images, client-side JS) from the "public" directory
 * Example: /styles.css maps to public/styles.css
 */
app.use(express.static(path.join(__dirname, 'public')));

// Server port - uses LOCAL_PORT in local mode, PORT in production, defaults to 3000
// Note: isLocalMode is defined earlier in the file (before Redis setup)
const port = isLocalMode
    ? (process.env.LOCAL_PORT || 3000)
    : (process.env.PORT || 3000);

// =============================================================================
// POSTGRESQL DATABASE CONNECTION
// =============================================================================
/**
 * PostgreSQL client for querying the MLS properties database.
 * The database contains tables:
 * - mls_properties: Main property listings with details
 * - mls_properties_details: Cached photos, virtual tours, open houses
 */

// Select the appropriate connection string based on mode
const connectionString = isLocalMode
    ? process.env.LOCAL_DATABASE_URL
    : process.env.DATABASE_URL;

const client = new Client({
    connectionString: connectionString,
    // Only use SSL for production (non-local) mode
    ...(!isLocalMode && {
        ssl: {
            rejectUnauthorized: false  // Allow connections to hosted databases
        }
    })
});

// Connect to database with proper error handling
client.connect()
    .then(() => {
        console.log(`-------✅ Database connected: ${isLocalMode ? 'Local (no SSL)' : 'Remote (SSL)'}`);
    })
    .catch((err) => {
        console.error('-------❌ Database connection failed:', err.message);
        console.error('Connection string used:', connectionString ? 'Set (hidden)' : 'UNDEFINED - check DATABASE_URL env var');
        process.exit(1);  // Exit if database connection fails
    });

// =============================================================================
// REDIS CONNECTION HANDLING (Production Only)
// =============================================================================
/**
 * Set up Redis event handlers and initiate connection.
 * Only executed in production mode - local mode skips Redis entirely.
 */
if (redisClient) {
    redisClient.on('error', (err) => {
        console.error('Redis connection error:', err);
    });

    redisClient.connect()
        .then(() => {
            console.log('-------✅ Redis connected successfully');
        })
        .catch((err) => {
            console.error('-------❌ Redis connection failed:', err.message);
        });
}

// =============================================================================
// DEFAULT SEARCH PARAMETERS
// =============================================================================
/**
 * Default values for property search filters.
 * These are used when no specific filters are provided by the user.
 */
console.log("-------✅ IN index.js - setting up default search params ----------------------");
const defaultParams = {
    propertyType: '',   // e.g., "Single Family Residence", "Condo"
    location: '',       // MLS area or region
    priceRange: '',     // Format: "minPrice-maxPrice"
    bedrooms: '',       // Minimum number of bedrooms
    bathrooms: '',      // Minimum number of bathrooms
    page: 1             // Pagination page number
};

// =============================================================================
// API ROUTES / ENDPOINTS
// =============================================================================

/**
 * GET / - Main Application Route
 * -----------------------------------------------------------------------------
 * Serves the frontend HTML interface with pre-populated data.
 *
 * HOW IT WORKS:
 * 1. Reads query parameters from the URL (e.g., /?propertyType=Condo)
 * 2. Retrieves any cached listings from the user's session
 * 3. Reads the form.html template file
 * 4. Injects the listings data and parameters into the HTML
 * 5. Sends the modified HTML to the browser
 *
 * TEMPLATE PLACEHOLDERS:
 * - <script>XXXXXX</script> → Replaced with SAMPLE_LISTINGS array
 * - <script>PARAMS</script> → Replaced with search parameters
 *
 * CONNECTION TO FRONTEND:
 * The frontend (form.html) uses these injected variables to:
 * - Display initial listings on page load
 * - Pre-fill search form fields
 */
app.get('/', async (req, res) => {
    console.log("-------✅ IN index.js - setting up / get endpoint ----------------------");
    try {
        const params = req.query;  // Get URL query parameters
        console.log('params is');
        console.log(params);

        // Retrieve listings from session (cached from previous searches)
        const listings = req.session.listings || [];

        // Read the HTML template file
        fs.readFile(path.join(__dirname, 'form.html'), 'utf8', (err, html) => {
            if (err) {
                console.error('Error reading form.html:', err);
                return res.status(500).send('Error loading form');
            }

            // Inject data into the HTML template by replacing placeholder scripts
            const modifiedHtml = html
                .replace('<script>XXXXXX</script>', `<script>let SAMPLE_LISTINGS = ${JSON.stringify(listings)};</script>`)
                .replace('<script>PARAMS</script>', `<script>let PARAMS = "${JSON.stringify(params)}";</script>`);

            // Send the complete HTML page to the browser
            res.send(modifiedHtml);

        });
    } catch (err) {
        console.error('Error retrieving listings:', err);
        res.status(500).send('Error retrieving listings');
    }
});

/**
 * POST /test-cors - CORS Testing Endpoint
 * -----------------------------------------------------------------------------
 * Simple endpoint to verify CORS is configured correctly.
 * Used during development to test cross-origin requests.
 */
app.post('/test-cors', (req, res) => {
    console.log("-------✅ IN index.js - setting up /test-cors post endpoint ----------------------");
    res.json({ message: "CORS is working!" });
});

/**
 * POST /search - Main Property Search Endpoint (PROTECTED)
 * -----------------------------------------------------------------------------
 * This is the primary API endpoint that the frontend calls to search properties.
 *
 * SECURITY: Requires valid API token (validateToken middleware)
 *
 * REQUEST BODY (JSON):
 * {
 *   propertyType: "Single Family Residence",  // Property type filter
 *   location: "La Paz",                       // Area/region filter
 *   priceRange: "100000-500000",              // Price range (min-max)
 *   bedrooms: 3,                              // Minimum bedrooms
 *   bathrooms: 2,                             // Minimum bathrooms
 *   cfe: true,                                // Has CFE electric (Mexican power)
 *   pool: true,                               // Has pool
 *   newListing: true,                         // Only new listings
 *   priceReduced: true,                       // Only price-reduced listings
 *   openHouse: true,                          // Has open house scheduled
 *   virtualTour: true                         // Has virtual tour available
 * }
 *
 * RESPONSE (JSON):
 * {
 *   success: true,
 *   data: [array of property listings with photos]
 * }
 *
 * FLOW:
 * 1. validateToken middleware checks API token
 * 2. fetchProperties() queries database with filters
 * 3. formatListingsRaw() enriches listings with photos/tours from Spark API
 * 4. Returns JSON response to frontend
 */
app.post('/search', validateToken, async (req, res) => {
    console.log("-------✅ IN index.js - setting up /search post endpoint ----------------------");
    console.log('body is');
    console.log(req.body);
    try {
        const listings = await fetchProperties(req);
        console.log('RETURNING listings from Endpoint:');
        console.log(listings.length);
        res.status(200).json({ success: true, data: listings });
    } catch (err) {
        console.error('Error fetching listings:', err);
        res.status(500).json({ success: false, message: 'Error retrieving listings', error: err.message });
    }
});

/**
 * POST /searchOrig - Original Search Endpoint (UNPROTECTED - Legacy)
 * -----------------------------------------------------------------------------
 * Same as /search but without token authentication.
 * Kept for backwards compatibility but should be deprecated.
 */
app.post('/searchOrig', async (req, res) => {
    console.log("-------✅ IN index.js - setting up /search post endpoint ----------------------");
    console.log('body is');
    console.log(req.body);
    try {
        const listings = await fetchProperties(req);
        console.log('RETURNING listings from Endpoint:');
        console.log(listings.length);
        res.status(200).json({ success: true, data: listings });
    } catch (err) {
        console.error('Error fetching listings:', err);
        res.status(500).json({ success: false, message: 'Error retrieving listings', error: err.message });
    }
});

/**
 * POST /test-location-match - Test endpoint for areaCitySubdivisionMatch
 * -----------------------------------------------------------------------------
 * Use this endpoint to test how user location input gets matched.
 *
 * REQUEST BODY (JSON):
 * {
 *   "location": "Cabo"  // or "Pedregal", "La Paz", "Pedrigal" (misspelled), etc.
 * }
 *
 * RESPONSE (JSON):
 * {
 *   success: true,
 *   input: "Cabo",
 *   matchResult: { ... },  // The result from areaCitySubdivisionMatch
 *   suggestedQuery: { ... } // How fetchProperties would use this data
 * }
 */
app.post('/test-location-match', async (req, res) => {
    console.log("-------✅ IN index.js - /test-location-match endpoint ----------------------");
    const { location } = req.body;

    console.log(`Testing location match for: "${location}"`);

    try {
        const matchResult = await areaCitySubdivisionMatch(location, client);

        // Build what the suggested SQL filter would look like
        let suggestedQuery = {
            description: '',
            sqlSnippet: ''
        };

        if (matchResult === null) {
            suggestedQuery.description = 'No match found - would fall back to LIKE search on all fields';
            suggestedQuery.sqlSnippet = `AND (city LIKE '%${location}%' OR mlsareamajor LIKE '%${location}%' OR subdivisionname LIKE '%${location}%')`;
        } else if (matchResult.ambiguous && matchResult.matches) {
            // Multiple matches - search across all matched values
            if (matchResult.matchedField === 'city') {
                const cityList = matchResult.matches.map(c => `'${c}'`).join(', ');
                suggestedQuery.description = `Ambiguous city match - would search across ${matchResult.matches.length} cities`;
                suggestedQuery.sqlSnippet = `AND city IN (${cityList})`;
            } else if (matchResult.matchedField === 'mlsareamajor') {
                const areaList = matchResult.matches.map(a => `'${a}'`).join(', ');
                suggestedQuery.description = `Ambiguous area match - would search across ${matchResult.matches.length} areas`;
                suggestedQuery.sqlSnippet = `AND mlsareamajor IN (${areaList})`;
            } else {
                const subdivList = matchResult.matches.map(s => `'${s.value || s}'`).join(', ');
                suggestedQuery.description = `Ambiguous subdivision match - would search across ${matchResult.matches.length} subdivisions`;
                suggestedQuery.sqlSnippet = `AND subdivisionname IN (${subdivList})`;
            }
        } else {
            // Clear match - use precise filters
            let filters = [];
            if (matchResult.city) filters.push(`city = '${matchResult.city}'`);
            if (matchResult.mlsareamajor) filters.push(`mlsareamajor = '${matchResult.mlsareamajor}'`);
            if (matchResult.subdivision) filters.push(`subdivisionname = '${matchResult.subdivision}'`);

            suggestedQuery.description = `Clear ${matchResult.matchType} match on ${matchResult.matchedField}`;
            suggestedQuery.sqlSnippet = filters.length > 0 ? 'AND ' + filters.join(' AND ') : 'No filters';
        }

        res.status(200).json({
            success: true,
            input: location,
            matchResult,
            suggestedQuery
        });

    } catch (err) {
        console.error('Error in location match test:', err);
        res.status(500).json({
            success: false,
            message: 'Error testing location match',
            error: err.message
        });
    }
});

// =============================================================================
// LOCATION MATCHING HELPER FUNCTION
// =============================================================================

/**
 * Location data cache - loaded once from database
 * Contains all valid combinations of city, mlsareamajor, and subdivisionname
 */
let locationLookupCache = null;

/**
 * levenshteinDistance - Calculate edit distance between two strings
 * -----------------------------------------------------------------------------
 * Classic dynamic programming implementation of Levenshtein distance.
 * Used for fuzzy matching to handle user typos/misspellings.
 *
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Number of single-character edits needed to transform str1 to str2
 */
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    // Create a matrix of distances
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    // Initialize base cases
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill in the rest of the matrix
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],     // deletion
                    dp[i][j - 1],     // insertion
                    dp[i - 1][j - 1]  // substitution
                );
            }
        }
    }

    return dp[m][n];
}

/**
 * loadLocationLookupData - Load location combinations from database
 * -----------------------------------------------------------------------------
 * Queries distinct city/mlsareamajor/subdivision combinations from mls_properties.
 * Results are cached in memory for subsequent calls.
 *
 * @param {Object} dbClient - PostgreSQL client
 * @returns {Array} Array of {city, mlsareamajor, subdivision} objects
 */
async function loadLocationLookupData(dbClient) {
    if (locationLookupCache) {
        return locationLookupCache;
    }

    console.log("-------✅ Loading location lookup data from database...");

    const query = `
        SELECT DISTINCT city, mlsareamajor, subdivisionname as subdivision
        FROM mls_properties
        WHERE city IS NOT NULL OR mlsareamajor IS NOT NULL OR subdivisionname IS NOT NULL
        ORDER BY city, mlsareamajor, subdivisionname
    `;

    const result = await dbClient.query(query);
    locationLookupCache = result.rows;

    console.log(`-------✅ Loaded ${locationLookupCache.length} location combinations`);
    return locationLookupCache;
}

/**
 * areaCitySubdivisionMatch - Match user input to location fields
 * =============================================================================
 * Attempts to match a user's location input to city, mlsareamajor, or subdivision
 * using a combination of exact matching, partial matching, and fuzzy matching.
 *
 * MATCHING PRIORITY:
 * 1. Exact match (case-insensitive)
 * 2. Starts-with match (input is prefix of a value)
 * 3. Contains match (input is substring of a value)
 * 4. Fuzzy match (Levenshtein distance within threshold)
 *
 * HIERARCHY LOGIC:
 * - If subdivision matched: return city + mlsareamajor + subdivision
 * - If mlsareamajor matched: return city + mlsareamajor (subdivision = null)
 * - If city matched: return city only (mlsareamajor + subdivision = null)
 * - If ambiguous: return all candidates with ambiguous flag
 * - If no match: return null
 *
 * @param {string} userInput - The location string from user
 * @param {Object} dbClient - PostgreSQL client for database queries
 * @returns {Object|null} Match result object or null if no match
 *
 * RETURN OBJECT STRUCTURE:
 * {
 *   city: string|null,
 *   mlsareamajor: string|null,
 *   subdivision: string|null,
 *   matchType: 'exact'|'startsWith'|'contains'|'fuzzy',
 *   matchedField: 'city'|'mlsareamajor'|'subdivision',
 *   confidence: number (0-1),
 *   ambiguous: boolean,
 *   matches: array (if ambiguous, contains all matching candidates)
 * }
 */
async function areaCitySubdivisionMatch(userInput, dbClient) {
    console.log(`-------✅ areaCitySubdivisionMatch called with: "${userInput}"`);

    if (!userInput || typeof userInput !== 'string' || userInput.trim() === '') {
        console.log("-------⚠️ Empty or invalid input");
        return null;
    }

    const normalized = userInput.toLowerCase().trim();
    const lookupData = await loadLocationLookupData(dbClient);

    // Track all matches found
    const matches = {
        exact: { city: [], mlsareamajor: [], subdivision: [] },
        startsWith: { city: [], mlsareamajor: [], subdivision: [] },
        contains: { city: [], mlsareamajor: [], subdivision: [] },
        fuzzy: { city: [], mlsareamajor: [], subdivision: [] }
    };

    // Get unique values for each field
    const uniqueCities = [...new Set(lookupData.map(r => r.city).filter(Boolean))];
    const uniqueAreas = [...new Set(lookupData.map(r => r.mlsareamajor).filter(Boolean))];
    const uniqueSubdivisions = [...new Set(lookupData.map(r => r.subdivision).filter(Boolean))];

    // Fuzzy match threshold (max edit distance allowed)
    const FUZZY_THRESHOLD = 3;

    // Helper function to check matches for a field
    const checkMatches = (values, fieldName) => {
        for (const value of values) {
            if (!value) continue;
            const valueLower = value.toLowerCase();

            // Exact match
            if (valueLower === normalized) {
                matches.exact[fieldName].push(value);
            }
            // Starts with
            else if (valueLower.startsWith(normalized)) {
                matches.startsWith[fieldName].push(value);
            }
            // Contains
            else if (valueLower.includes(normalized) || normalized.includes(valueLower)) {
                matches.contains[fieldName].push(value);
            }
            // Fuzzy match (only for inputs >= 4 chars to avoid too many false positives)
            else if (normalized.length >= 4) {
                const distance = levenshteinDistance(normalized, valueLower);
                // Scale threshold based on word length
                const adjustedThreshold = Math.min(FUZZY_THRESHOLD, Math.floor(valueLower.length / 3));
                if (distance <= adjustedThreshold) {
                    matches.fuzzy[fieldName].push({ value, distance });
                }
            }
        }
    };

    // Check all three fields
    checkMatches(uniqueCities, 'city');
    checkMatches(uniqueAreas, 'mlsareamajor');
    checkMatches(uniqueSubdivisions, 'subdivision');

    // Helper to find the full record(s) for a matched value
    const findRecordsForValue = (fieldName, value) => {
        return lookupData.filter(r => {
            const fieldValue = r[fieldName];
            return fieldValue && fieldValue.toLowerCase() === value.toLowerCase();
        });
    };

    // Process matches in priority order: exact > startsWith > contains > fuzzy
    // And field priority: subdivision > mlsareamajor > city (most specific first for exact)
    // But for partial matches, city first (broadest)

    const buildResult = (matchType, fieldName, value, confidence, allMatches = null) => {
        const records = findRecordsForValue(fieldName, value);

        // If multiple records have this value, we need to handle that
        const uniqueParents = {
            cities: [...new Set(records.map(r => r.city).filter(Boolean))],
            areas: [...new Set(records.map(r => r.mlsareamajor).filter(Boolean))],
            subdivisions: [...new Set(records.map(r => r.subdivision).filter(Boolean))]
        };

        let result = {
            city: null,
            mlsareamajor: null,
            subdivision: null,
            matchType,
            matchedField: fieldName,
            matchedValue: value,
            confidence,
            ambiguous: false,
            inputReceived: userInput
        };

        switch (fieldName) {
            case 'subdivision':
                result.subdivision = value;
                // If subdivision maps to single city/area, populate those
                if (uniqueParents.cities.length === 1) result.city = uniqueParents.cities[0];
                if (uniqueParents.areas.length === 1) result.mlsareamajor = uniqueParents.areas[0];
                // If multiple parents, note ambiguity
                if (uniqueParents.cities.length > 1 || uniqueParents.areas.length > 1) {
                    result.ambiguous = true;
                    result.possibleCities = uniqueParents.cities;
                    result.possibleAreas = uniqueParents.areas;
                }
                break;

            case 'mlsareamajor':
                result.mlsareamajor = value;
                // Find the city for this area
                if (uniqueParents.cities.length === 1) result.city = uniqueParents.cities[0];
                if (uniqueParents.cities.length > 1) {
                    result.ambiguous = true;
                    result.possibleCities = uniqueParents.cities;
                }
                break;

            case 'city':
                result.city = value;
                // City is broadest - don't populate children
                break;
        }

        // If we have multiple matches at this level, flag as ambiguous
        if (allMatches && allMatches.length > 1) {
            result.ambiguous = true;
            result.matches = allMatches;
        }

        return result;
    };

    // === EXACT MATCHES (highest priority) ===
    // Check subdivision first (most specific)
    if (matches.exact.subdivision.length === 1) {
        return buildResult('exact', 'subdivision', matches.exact.subdivision[0], 1.0);
    }
    if (matches.exact.subdivision.length > 1) {
        return buildResult('exact', 'subdivision', matches.exact.subdivision[0], 1.0, matches.exact.subdivision);
    }

    // Then mlsareamajor
    if (matches.exact.mlsareamajor.length === 1) {
        return buildResult('exact', 'mlsareamajor', matches.exact.mlsareamajor[0], 1.0);
    }
    if (matches.exact.mlsareamajor.length > 1) {
        return buildResult('exact', 'mlsareamajor', matches.exact.mlsareamajor[0], 1.0, matches.exact.mlsareamajor);
    }

    // Then city
    if (matches.exact.city.length === 1) {
        return buildResult('exact', 'city', matches.exact.city[0], 1.0);
    }
    if (matches.exact.city.length > 1) {
        return buildResult('exact', 'city', matches.exact.city[0], 1.0, matches.exact.city);
    }

    // === STARTS WITH MATCHES ===
    // For partial matches, prefer city (broader search)
    const allStartsWith = [
        ...matches.startsWith.city.map(v => ({ field: 'city', value: v })),
        ...matches.startsWith.mlsareamajor.map(v => ({ field: 'mlsareamajor', value: v })),
        ...matches.startsWith.subdivision.map(v => ({ field: 'subdivision', value: v }))
    ];

    if (allStartsWith.length === 1) {
        const match = allStartsWith[0];
        return buildResult('startsWith', match.field, match.value, 0.9);
    }
    if (allStartsWith.length > 1) {
        // Multiple matches - check if they're all cities (common case like "Cabo")
        const cityMatches = allStartsWith.filter(m => m.field === 'city');
        if (cityMatches.length > 0) {
            // Return cities as ambiguous match
            return {
                city: null,
                mlsareamajor: null,
                subdivision: null,
                matchType: 'startsWith',
                matchedField: 'city',
                confidence: 0.85,
                ambiguous: true,
                inputReceived: userInput,
                matches: cityMatches.map(m => m.value),
                allMatches: allStartsWith
            };
        }
        // Otherwise return first match as ambiguous
        const firstMatch = allStartsWith[0];
        return buildResult('startsWith', firstMatch.field, firstMatch.value, 0.85, allStartsWith.map(m => m.value));
    }

    // === CONTAINS MATCHES ===
    const allContains = [
        ...matches.contains.city.map(v => ({ field: 'city', value: v })),
        ...matches.contains.mlsareamajor.map(v => ({ field: 'mlsareamajor', value: v })),
        ...matches.contains.subdivision.map(v => ({ field: 'subdivision', value: v }))
    ];

    if (allContains.length === 1) {
        const match = allContains[0];
        return buildResult('contains', match.field, match.value, 0.8);
    }
    if (allContains.length > 1) {
        // Multiple contains matches - prefer city level for broad search
        const cityMatches = allContains.filter(m => m.field === 'city');
        if (cityMatches.length > 0) {
            return {
                city: null,
                mlsareamajor: null,
                subdivision: null,
                matchType: 'contains',
                matchedField: 'city',
                confidence: 0.75,
                ambiguous: true,
                inputReceived: userInput,
                matches: cityMatches.map(m => m.value),
                allMatches: allContains
            };
        }
        const firstMatch = allContains[0];
        return buildResult('contains', firstMatch.field, firstMatch.value, 0.75, allContains.map(m => m.value));
    }

    // === FUZZY MATCHES ===
    const allFuzzy = [
        ...matches.fuzzy.city.map(m => ({ field: 'city', value: m.value, distance: m.distance })),
        ...matches.fuzzy.mlsareamajor.map(m => ({ field: 'mlsareamajor', value: m.value, distance: m.distance })),
        ...matches.fuzzy.subdivision.map(m => ({ field: 'subdivision', value: m.value, distance: m.distance }))
    ].sort((a, b) => a.distance - b.distance); // Sort by distance (closest first)

    if (allFuzzy.length === 1) {
        const match = allFuzzy[0];
        const confidence = Math.max(0.5, 1 - (match.distance * 0.15));
        return buildResult('fuzzy', match.field, match.value, confidence);
    }
    if (allFuzzy.length > 1) {
        const firstMatch = allFuzzy[0];
        const confidence = Math.max(0.5, 1 - (firstMatch.distance * 0.15));
        return buildResult('fuzzy', firstMatch.field, firstMatch.value, confidence, allFuzzy.map(m => ({ value: m.value, field: m.field, distance: m.distance })));
    }

    // No matches found
    console.log(`-------⚠️ No matches found for: "${userInput}"`);
    return null;
}

// =============================================================================
// CORE BUSINESS LOGIC - PROPERTY SEARCH FUNCTION
// =============================================================================

/**
 * fetchProperties - Core Database Query Function
 * -----------------------------------------------------------------------------
 * This is the main function that queries the PostgreSQL database for properties.
 * It builds a dynamic SQL query based on the user's search filters.
 *
 * PARAMETERS (from req.body):
 * - propertyType: Filter by property type (e.g., "Single Family Residence")
 * - location: Filter by MLS area (supports "All La Paz" for wildcard)
 * - priceRange: Price range as "min-max" string
 * - bedrooms: Minimum number of bedrooms
 * - bathrooms: Minimum number of bathrooms
 * - cfe: Boolean - filter for CFE electric (Mexican power grid)
 * - pool: Boolean - filter for properties with pools
 * - newListing: Boolean - only "New Listing" properties
 * - priceReduced: Boolean - only "Price Reduced" properties
 * - openHouse: Boolean - only properties with open houses
 * - virtualTour: Boolean - only properties with virtual tours
 *
 * DATABASE TABLES USED:
 * - mls_properties: Main property data from MLS feed
 *
 * RETURNS:
 * Array of property objects with photos and virtual tours attached
 * (via formatListingsRaw from routes/db.js)
 *
 * CONNECTION TO OTHER COMPONENTS:
 * - Called by: /search and /searchOrig endpoints
 * - Calls: formatListingsRaw() in routes/db.js to enrich data with photos
 */
const fetchProperties = async (req) => {
    console.log("-------✅ IN index.js - setting fetchProperties function ----------------------");

    const propInfo = req.body;
    console.log('body info is:');
    console.log(propInfo);

    // Destructure all possible search filters from request body
    const { propertyType, location, priceRange, bedrooms, bathrooms, cfe, pool, newListing, priceReduced, openHouse, virtualTour, page } = propInfo;

    // =========================================================================
    // LOCATION MATCHING - Resolve user input to city/area/subdivision
    // =========================================================================
    let locationMatch = null;
    if (location) {
        locationMatch = await areaCitySubdivisionMatch(location, client);
        console.log('========== LOCATION MATCH RESULT ==========');
        console.log(`Input: "${location}"`);
        console.log('Match Result:', JSON.stringify(locationMatch, null, 2));

        if (locationMatch) {
            console.log('--- Summary ---');
            console.log(`  Match Type: ${locationMatch.matchType}`);
            console.log(`  Matched Field: ${locationMatch.matchedField}`);
            console.log(`  Matched Value: ${locationMatch.matchedValue}`);
            console.log(`  Confidence: ${locationMatch.confidence}`);
            console.log(`  Ambiguous: ${locationMatch.ambiguous}`);
            if (locationMatch.city) console.log(`  City: ${locationMatch.city}`);
            if (locationMatch.mlsareamajor) console.log(`  MLS Area Major: ${locationMatch.mlsareamajor}`);
            if (locationMatch.subdivision) console.log(`  Subdivision: ${locationMatch.subdivision}`);
            if (locationMatch.matches) console.log(`  Multiple Matches: ${JSON.stringify(locationMatch.matches)}`);
        } else {
            console.log('  No match found - will fall back to LIKE search');
        }
        console.log('============================================');
    }

    try {
        // Define which fields to retrieve from the database
        // These fields are used by the frontend to display property cards
        const fieldList = 'id, mlsid, listingid, originatingsystemlistingid,  city, mlsareamajor, subdivisionname, postalcode, buildingareatotal, propertyclass, propertytypelabel, lotsizedimensions, latitude, longitude, interiorfeatures, electric, architecturalstyle, patioandporchfeatures, poolfeatures, exteriorfeatures, roomstotal, kitchenappliances, bedstotal, bathroomstotaldecimal, publicremarks, petsallowed, currentpricepublic, majorchangetype, streetname, streetnumberinteger, streetadditionalinfo, unparsedaddress, unparsedfirstlineaddress, photoscount, virtualtourscount, openhousescount, yearbuilt';

        // =====================================================================
        // DYNAMIC SQL QUERY BUILDING
        // =====================================================================
        // Start with base query - "WHERE 1=1" allows easy appending of AND clauses
        let query = `SELECT ${fieldList} FROM mls_properties WHERE 1=1`;

        // Property Type Filter
        if (propertyType) query += ` AND propertytypelabel = '${propertyType}'`;

        // Location Filter - Uses areaCitySubdivisionMatch result for smart filtering
        if (location) {
            // Special case: "All La Paz" wildcard search
            const allIncludeLocations = {
                'All La Paz': ` AND mlsareamajor LIKE '%La Paz%'`
            };

            if (allIncludeLocations[location]) {
                query += allIncludeLocations[location];
            } else if (locationMatch === null) {
                // No match found - fall back to LIKE search on all location fields
                query += ` AND (city LIKE '%${location}%' OR mlsareamajor LIKE '%${location}%' OR subdivisionname LIKE '%${location}%')`;
            } else if (locationMatch.ambiguous && locationMatch.matches) {
                // Multiple matches - search across all matched values
                if (locationMatch.matchedField === 'city') {
                    const cityList = locationMatch.matches.map(c => `'${c}'`).join(', ');
                    query += ` AND city IN (${cityList})`;
                } else if (locationMatch.matchedField === 'mlsareamajor') {
                    const areaList = locationMatch.matches.map(a => `'${a}'`).join(', ');
                    query += ` AND mlsareamajor IN (${areaList})`;
                } else {
                    // subdivision matches
                    const subdivList = locationMatch.matches.map(s => `'${s.value || s}'`).join(', ');
                    query += ` AND subdivisionname IN (${subdivList})`;
                }
            } else {
                // Clear match - use precise filters based on matched level
                if (locationMatch.subdivision) {
                    // Most specific: filter by subdivision (city/area already implied)
                    query += ` AND subdivisionname = '${locationMatch.subdivision}'`;
                } else if (locationMatch.mlsareamajor) {
                    // Mid-level: filter by area
                    query += ` AND mlsareamajor = '${locationMatch.mlsareamajor}'`;
                } else if (locationMatch.city) {
                    // Broadest: filter by city
                    query += ` AND city = '${locationMatch.city}'`;
                }
            }
        }

        // Price Range Filter - Parse "min-max" format
        if (priceRange) {
            const [minPrice, maxPrice] = priceRange.split('-');
            //query += ` AND listprice BETWEEN ${minPrice} AND ${maxPrice || '999999999'}`;
            query += ` AND currentpricepublic BETWEEN ${minPrice} AND ${maxPrice || '999999999'}`;

        }

        // Bedroom/Bathroom Filters (minimum values)
        if (bedrooms) query += ` AND bedstotal >= ${bedrooms}`;
        if (bathrooms) query += ` AND bathsfull >= ${bathrooms}`;

        // Feature Filters (boolean toggles)
        if(cfe) query += " AND electric LIKE '%CFE%'";           // CFE electric
        if(pool) query += " AND poolfeatures LIKE '%Pool%'";      // Has pool
        if(newListing) query += " AND majorchangetype = 'New Listing'";
        if(priceReduced) query += " AND majorchangetype = 'Price Reduced'";
        if(openHouse) query += " AND openhousescount > 0";
        if(virtualTour) query += " AND virtualtourcount > 0";

        // Sort by price high to low
        query += " ORDER BY currentpricepublic DESC";

        // Limit results to prevent overwhelming responses
        query += " LIMIT 50";
        console.log('property query:', query);

        // =====================================================================
        // EXECUTE QUERY AND ENRICH WITH PHOTOS
        // =====================================================================
        const result = await client.query(query);
        console.log(`I have ${result.rows.length} results`);

        // formatListingsRaw enriches each listing with:
        // - Photos from Spark API (cached in mls_properties_details table)
        // - Virtual tours
        // - Open house information
        const listingsPopulated = await formatListingsRaw(req, result.rows, client);
        return listingsPopulated;

    } catch (err) {
        console.error(err);
        throw new Error('Failed to fetch properties');
    }
};

// =============================================================================
// SERVER STARTUP
// =============================================================================
/**
 * Start the Express server on the configured port.
 * In production (Heroku), PORT is set via environment variable.
 * In development, defaults to port 3000.
 */
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
