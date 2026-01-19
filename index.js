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

if (!isLocalMode) {
    // Production mode: Connect to Redis with TLS
    redisClient = redis.createClient({
        url: process.env.REDIS_URL,      // Redis connection URL from environment
        socket: {
            tls: true,                    // Enable TLS encryption
            rejectUnauthorized: false     // Allow self-signed certificates (common for hosted Redis)
        }
    });
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

client.connect();  // Establish database connection
console.log(`-------✅ Database connected: ${isLocalMode ? 'Local (no SSL)' : 'Remote (SSL)'}`);

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

    redisClient.connect();  // Initiate connection to Redis
    console.log('-------✅ Redis connection initiated');
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

        // Location Filter - Special handling for "All La Paz" wildcard searches
        if (location) {
            const allIncludeLocations = {
                'All La Paz': [` AND mlsareamajor LIKE '%La Paz%'`]
            };

            if (allIncludeLocations[location]) {
                // Use LIKE for wildcard location searches
                query += allIncludeLocations[location].join('');
            } else {
                // Exact match for specific locations
                query += ` AND mlsareamajor = '${location}'`;
            }
        }

        // Price Range Filter - Parse "min-max" format
        if (priceRange) {
            const [minPrice, maxPrice] = priceRange.split('-');
            query += ` AND listprice BETWEEN ${minPrice} AND ${maxPrice || '999999999'}`;
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
