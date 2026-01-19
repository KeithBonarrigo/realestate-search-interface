/**
 * =============================================================================
 * DATABASE UTILITY MODULE (routes/db.js)
 * =============================================================================
 *
 * This module provides database query utilities and data formatting functions
 * for the MLS property search application.
 *
 * PRIMARY RESPONSIBILITIES:
 * 1. Format raw database results into usable structures
 * 2. Fetch property photos/tours from external Spark API
 * 3. Cache photo data in the database to reduce API calls
 * 4. Provide helper functions for data transformation
 *
 * EXTERNAL API INTEGRATION:
 * This module communicates with the Spark API (replication.sparkapi.com)
 * to fetch property photos, virtual tours, and open house information.
 *
 * DATABASE TABLES USED:
 * - mls_properties: Main property listings
 * - mls_properties_details: Cached photos, tours, open houses
 *
 * EXPORTED FUNCTIONS:
 * - formatListings: Basic HTML formatting (legacy)
 * - formatListingsMap: Format with map data (legacy)
 * - formatListingsRaw: JSON format with photos/tours (MAIN FUNCTION USED)
 *
 * CONNECTION TO index.js:
 * - formatListingsRaw is called by fetchProperties() in index.js
 * - Results are returned to the /search endpoint
 * =============================================================================
 */

const express = require('express');
const { Client } = require('pg');
const router = express.Router();
const axios = require('axios');  // HTTP client for external API calls

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * jsonToHtml - Convert JSON object to HTML list
 * -----------------------------------------------------------------------------
 * Recursively converts a JSON object into an HTML unordered list.
 * Used for debugging/displaying raw listing data.
 *
 * @param {Object} json - The JSON object to convert
 * @returns {string} HTML string representation of the object
 *
 * NOTE: This is a legacy function, primarily used in formatListingsMap
 */
function jsonToHtml(json) {
    console.log("--------------🚀 IN db.js - jsonToHtml function");
    let htmlOutput = "<ul>";

    for (let key in json) {
        if (json.hasOwnProperty(key)) {
            let value = json[key];
            const isKeyObj = typeof json[key] === 'object' && json[key] !== null;

            if (isKeyObj) {
                // Recursively handle nested objects
                htmlOutput += `<li><strong>${key}:</strong> ${jsonToHtml(value)}</li>`;
            } else {
                htmlOutput += `<li><strong>${key}:</strong> ${value}</li>`;
            }
        }
    }

    htmlOutput += "</ul>";
    return htmlOutput;
}

// =============================================================================
// SPARK API INTEGRATION FUNCTIONS
// =============================================================================
/**
 * These functions communicate with the Spark MLS API to fetch additional
 * property data that isn't stored in our local database:
 * - Property photos (multiple sizes available)
 * - Virtual tours (3D walkthroughs, video tours)
 * - Open house schedules
 *
 * API DOCUMENTATION: https://sparkplatform.com/docs/api_services
 * AUTHENTICATION: Bearer token (hardcoded - should be moved to env vars)
 */

/**
 * getListingPhotos - Fetch photos for a property from Spark API
 * -----------------------------------------------------------------------------
 * Retrieves all available photos for a listing from the Spark API.
 * Photos come in multiple sizes (Uri300, Uri640, UriLarge, etc.)
 *
 * @param {string} id - The MLS listing ID
 * @param {Object} creds - Optional credentials (not currently used)
 * @returns {Array} Array of photo objects with URIs for different sizes
 *
 * CALLED BY: formatListingsRaw() when photos aren't cached in database
 */
async function getListingPhotos(id, creds=null) {
    console.log("--------------🚀 IN db.js - getListingPhotos function");
    const url = `https://replication.sparkapi.com/v1/listings/${id}/photos`;
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer 54hzhrgqpqlinl3ciui6wum3f`,
                'Accept': 'application/json'
            }
        });
        return response.data.D.Results || [];
    } catch (error) {
        if (error.response) {
            console.error(`Error fetching photos for MLS ID ${id}:`, error.response.data);
        } else if (error.request) {
            console.error(`No response received for MLS ID ${id}:`, error.request);
        } else {
            console.error(`Error setting up request for MLS ID ${id}:`, error.message);
        }
        return [];
    }
}

/**
 * getListingPhotosOpensToursSearch - Stub function (not fully implemented)
 * -----------------------------------------------------------------------------
 * Placeholder for fetching photos, open houses, and tours in a single call.
 * Currently returns empty array - functionality moved to separate functions.
 */
async function getListingPhotosOpensToursSearch(listing, client, creds=null) {
    console.log("--------------🚀 IN db.js - getListingPhotosOpensToursSearch function");
    const url = `https://replication.sparkapi.com/v1/listings/${listing.id}/photos`;
    return []  // Stub - actual implementation in separate functions
}

/**
 * getVrTours - Fetch virtual tours for a property from Spark API
 * -----------------------------------------------------------------------------
 * Retrieves virtual tour links (Matterport, video tours, etc.) for a listing.
 *
 * @param {string} id - The MLS listing ID
 * @param {Object} creds - Optional credentials (not currently used)
 * @returns {Array} Array of virtual tour objects with URLs
 *
 * CALLED BY: checkTourAndOpenDetails() when tours aren't cached
 */
async function getVrTours(id, creds=null) {
    console.log("--------------🚀 IN db.js - getVrTours function");
    const url = `https://replication.sparkapi.com/v1/listings/${id}/virtualtours`;
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer 54hzhrgqpqlinl3ciui6wum3f`,
                'Accept': 'application/json'
            }
        });
        return response.data.D.Results || [];
    } catch (error) {
        if (error.response) {
            console.error(`Error fetching vr tours for MLS ID ${id}:`, error.response.data);
        } else if (error.request) {
            console.error(`No response received for MLS ID ${id}:`, error.request);
        } else {
            console.error(`Error setting up request for MLS ID ${id}:`, error.message);
        }
        return [];
    }
}

/**
 * getOpenHouses - Fetch open house schedules from Spark API
 * -----------------------------------------------------------------------------
 * Retrieves scheduled open house events for a listing.
 *
 * @param {string} id - The MLS listing ID
 * @param {Object} creds - Optional credentials (not currently used)
 * @returns {Array} Array of open house objects with dates/times
 *
 * CALLED BY: checkTourAndOpenDetails() when open houses aren't cached
 */
async function getOpenHouses(id, creds=null) {
    console.log("--------------🚀 IN db.js - getOpenHouses function");
    const url = `https://replication.sparkapi.com/v1/listings/${id}/openhouses/all`
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer 54hzhrgqpqlinl3ciui6wum3f`,
                'Accept': 'application/json'
            }
        });
        return response.data.D.Results || [];
    } catch (error) {
        if (error.response) {
            console.error(`Error fetching open houses for MLS ID ${id}:`, error.response.data);
        } else if (error.request) {
            console.error(`No response received for MLS ID ${id}:`, error.request);
        } else {
            console.error(`Error setting up request for MLS ID ${id}:`, error.message);
        }
        return [];
    }
}

/**
 * isObject - Type checking utility
 * -----------------------------------------------------------------------------
 * Simple helper to check if a value is a non-null object.
 *
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a non-null object
 */
function isObject(value) {
    console.log("--------------🚀 IN db.js - isObject function");
    return typeof value === 'object' && value !== null;
}


// =============================================================================
// LISTING FORMATTING FUNCTIONS
// =============================================================================

/**
 * formatListingsMap - Generate HTML page with map view (LEGACY)
 * -----------------------------------------------------------------------------
 * Creates a complete HTML page with:
 * - Leaflet.js interactive map showing property markers
 * - List of properties below the map
 *
 * NOTE: This is a legacy function. The current frontend (form.html) handles
 * its own map rendering. This function generates a standalone HTML page.
 *
 * @param {Array} listingData - Array of property objects from database
 * @returns {string} Complete HTML document as string
 *
 * FEATURES:
 * - Auto-calculates map center based on property coordinates
 * - Fetches photos from Spark API for each listing
 * - Creates clickable map markers with property popups
 */
async function formatListingsMap(listingData) {
    console.log("--------------🚀 IN db.js - formatListingsMap function");

    // Calculate map bounds from property coordinates
    let latitudes = listingData.map(listing => listing.latitude);
    let longitudes = listingData.map(listing => listing.longitude);

    let minLat = Math.min(...latitudes);
    let maxLat = Math.max(...latitudes);
    let minLng = Math.min(...longitudes);
    let maxLng = Math.max(...longitudes);

    let centerLat = (minLat + maxLat) / 2;
    let centerLng = (minLng + maxLng) / 2;

    // Initialize the map
    
    // Fetch the photos asynchronously for each listing before generating the HTML
    for (let listing of listingData) {
        const photos = await getListingPhotos(listing.id);  // Fetch photos
        listing.imageUrl = null;

        if(listing.virtualtourscount > 0){ //Fetch VR Tours if available
            const vrTours = await getVrTours(listing.virtualtourscount); 
        }
        listing.vrTour = null;

        if (photos && isObject(photos)) {
            listing.photos = photos;  // Attach photos to the listing data
            let imageUrl = null;
            //listing.imageUrl = imageUrl;
            listing.imageUrl = listing.photos[0];
        }

        if (vrTours && isObject(vrTours)) {
            listing.vrTours = vrTours;  // Attach photos to the listing data
            let firstVrTour = null;
            //listing.imageUrl = imageUrl;
            listing.vrTour = listing.vrTours[0];
            //console.log(`virtual tours for ${listing.id}`);
            //console.log(listing.vrTours);
        }
    }

    //let imageUrl = null;
    //imageUrl = listing.photos[0]['Uri300'];


    const mapHtml = `
        <div id="map"></div>
        <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
        <script>
            document.addEventListener('DOMContentLoaded', function() {
                const map = L.map('map').setView([${centerLat}, ${centerLng}], 10);

                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                }).addTo(map);


                ${listingData.map(listing => {
                    
                    // Format the current price as currency
                    let formattedPrice = new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                    }).format(listing.currentpricepublic);

                    // Create the image source URL
                    //let imageUrl = `https://cdn.resize.sparkplatform.com/cab/640x480/true/${listing.id}-o.jpg`;

                    
                   let firstImage = listing.photos[0];
                    if(firstImage && isObject(firstImage)){
                        //console.log(`imageUrl is ${imageUrl}`);
                        //Object.keys(firstImage).forEach(key => {
                            //console.log(`photos for ${listing.id}`);
                            //console.log(`${key}: ${firstImage[key]}`);
                            //myPhotoEntry = listing.photos[key];
                            //photoGalleryString += `<a onclick="handleImageClick(this)"><img class="gallery-photo" src="${myImg}" id="${myImg}-${mlsId}"></a>`;
                        //});
                    }else{
                        console.log(`no photos for ${listing.id}`);
                    }
                    
                    //console.log(listing.photos[0].UriLarge);
                    


                    // Add a marker to the map
                    return `
                        L.marker([${listing.latitude}, ${listing.longitude}]).addTo(map)
                            .bindPopup(\`
                                <div class="listing">
                                    <img src="${listing.imageUrl}" alt="Property Image">
                                    <div>
                                        <p><strong>ID:</strong> ${listing.id}</p>
                                        <p><strong>MLS Area Major:</strong> ${listing.mlsareamajor}</p>
                                        <p><strong>Current Public Price:</strong> ${formattedPrice}</p>
                                        <p><strong>Property Type Label:</strong> ${listing.propertyclass} ${listing.propertytypelabel}</p>
                                        <p><strong>Public Remarks:</strong> ${listing.publicremarks}</p>
                                        <p><strong>Latitude, Longitude:</strong> (${listing.latitude}, ${listing.longitude})</p>
                                    </div>
                                </div>
                            \`);
                    `;
                }).join('')}
            });
        </script>
    `;

    // Format the listings
    let formattedListings = listingData.map(listing => {
        // Format the current price as currency
        let formattedPrice = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(listing.currentpricepublic);

        const myListingJson = jsonToHtml(listing);

        // Create the image source URL
        //let imageUrl = `https://cdn.resize.sparkplatform.com/cab/640x480/true/${listing.id}-o.jpg`;

        return `
            <div class="listing" style="display: flex; align-items: flex-start; margin-bottom: 20px;">
                <img src="${listing.imageUrl}" alt="Property Image" style="margin-right: 20px; width: 150px; height: 100px; object-fit: cover;">
                <div>
                    <p><strong>ID:</strong> ${listing.id}</p>
                    <p><strong>MLS Area Major:</strong> ${listing.mlsareamajor}</p>
                    <p><strong>Current Public Price:</strong> ${formattedPrice}</p>
                    <p><strong>Property Type Label:</strong> ${listing.propertyclass} ${listing.propertytypelabel}</p>
                    <p><strong>Public Remarks:</strong> ${listing.publicremarks}</p>
                    <p><strong>Latitude, Longitude:</strong> (${listing.latitude}, ${listing.longitude})</p>
                </div>
            </div>
            
            <div class='jsonListing'>${myListingJson}</div>

        `;
    }).join('');

    // Return the complete HTML including map and listings
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Property Listings with Map</title>
            <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
            <style>
                #map {
                    height: 600px;
                    margin-bottom: 20px;
                }
                .listing {
                    display: flex;
                    align-items: flex-start;
                    margin-bottom: 20px;
                }
                .listing img {
                    margin-right: 20px;
                    width: 150px;
                    height: 100px;
                    object-fit: cover;
                }
                .jsonListing {
                    display:none;
                }
            </style>
        </head>
        <body>
            ${mapHtml}
            <div id="listings">
                ${formattedListings}
            </div>
        </body>
        </html>
    `;
}

/**
 * formatListingsRaw - Main listing enrichment function (PRIMARY FUNCTION)
 * =============================================================================
 * This is the MAIN function used by the application. It enriches raw database
 * listings with photos and virtual tours, using a caching strategy.
 *
 * CACHING STRATEGY:
 * 1. First checks mls_properties_details table for cached photos/tours
 * 2. If not cached, fetches from Spark API and caches in database
 * 3. This reduces API calls and improves response times
 *
 * DATABASE TABLE: mls_properties_details
 * - mlsid: Property ID (foreign key to mls_properties)
 * - photos: JSONB array of photo objects
 * - virtual_tours: JSONB array of tour objects
 * - open_houses: JSONB array of open house objects
 * - *_edited: Timestamps for when data was last updated
 *
 * @param {Object} req - Express request object
 * @param {Array} listingData - Array of property objects from database query
 * @param {Object} client - PostgreSQL client for database queries
 * @returns {Array} Same array with photos and vTours properties added
 *
 * CALLED BY: fetchProperties() in index.js
 *
 * FLOW FOR EACH LISTING:
 * 1. Query mls_properties_details for cached photos
 * 2. If no cache: fetch from Spark API → save to database → attach to listing
 * 3. If cached: parse JSON → attach to listing
 * 4. Repeat for virtual tours using checkTourAndOpenDetails()
 * 5. Return enriched listings array
 */
async function formatListingsRaw(req, listingData, client) {
    console.log("--------------🚀 IN db.js - formatListingsRaw function");
    let listingDataRaw = [];
    console.log('listings data length', listingData.length);

    // Process each listing to add photos and tours
    for (let listing of listingData) {

        // =====================================================================
        // STEP 1: CHECK DATABASE CACHE FOR PHOTOS
        // =====================================================================
        const photoCheckQuery = `SELECT mlsid, time_entered, photos_edited, photos, open_houses, virtual_tours, open_houses_edited, virtual_tours_edited FROM mls_properties_details WHERE mlsid = '${listing.id}' LIMIT 1`
        const photoResult = await client.query(photoCheckQuery);
        let photosRetrieved = photoResult.rows.length > 0 ? photoResult.rows[0]['photos'] : '[]';

        let photos = [];
        let vTours = [];
        let detailsInDb = false;
        let photoInsert = '';
        let photosForDb = '';
        let openHousesRetrieved = null;
        let vToursRetrieved = null

        // =====================================================================
        // STEP 2: FETCH OR RETRIEVE PHOTOS
        // =====================================================================
        if(photoResult.rows == 0 || photosRetrieved.length == 0){
            // NO CACHE: Fetch photos from Spark API
            photos = await getListingPhotos(listing.id);
            listing.imageUrl = null;

            let insertUpdatePhotoDataResultCount;
            if(photoResult.rows == 0){
                // No row exists - INSERT new record
                console.log('inserting photos');
                insertUpdatePhotoDataResultCount = await insertPhotosOpensToursToDb(listing.id, 'photos', 'photos_edited', photos, client, 'insert');
            }else{
                // Row exists but photos empty - UPDATE existing record
                console.log('updating photos');
                insertUpdatePhotoDataResultCount = await insertPhotosOpensToursToDb(listing.id, 'photos', 'photos_edited', photos, client, 'update');
            }
            listing.photos = photos;
            console.log(`Photo Rows affected: ${insertUpdatePhotoDataResultCount}`);
        }else{
            // CACHE HIT: Use photos from database
            console.log(`photos found in DB for ${listing.id}`);
            detailsInDb = true;
            if (photoResult.rows.length > 0 && photosRetrieved.length > 0) {
                let photosRaw = photosRetrieved;
                photosRetrieved = checkPhotoTourResFromDb(photosRaw);
                listing.photos = photosRetrieved;
            }else{
                console.log(`no photos Retrieved for ${listing.id}`);
            }
            listing.photos = photosRetrieved;
        }

        // =====================================================================
        // STEP 3: FETCH OR RETRIEVE VIRTUAL TOURS
        // =====================================================================
        let detailValueToCheck = [];
        if(detailsInDb) detailValueToCheck = photoResult.rows[0].virtual_tours;

        // Use helper function to check cache and fetch if needed
        let vToursCheck = await checkTourAndOpenDetails(listing, listing.virtualtourscount, detailValueToCheck, detailsInDb, client, 'vTours');
        listing.vTours = vToursCheck;
        listing.vrTours = vToursCheck;  // Duplicate property for compatibility

        // Log results for debugging
        if( listing.photos){
            console.log(`${listing.id} - data raw photos:`);
            console.log(listing.photos.length);
        }
        if( listing.vTours){
            console.log(`${listing.id} - data raw vTours:`);
            console.log(listing.vTours.length);
        }
    }

    return listingData;
}

// =============================================================================
// DATABASE CACHING HELPER FUNCTIONS
// =============================================================================

/**
 * checkTourAndOpenDetails - Cache-aware fetch for tours and open houses
 * -----------------------------------------------------------------------------
 * Checks if virtual tours or open houses are cached in the database.
 * If not cached and the listing has them, fetches from Spark API and caches.
 *
 * @param {Object} listing - The property listing object
 * @param {number} listingFieldToCheck - Count of items (e.g., virtualtourscount)
 * @param {*} rawToCheck - Cached data from database (if any)
 * @param {boolean} detailsInDb - Whether any cached details exist
 * @param {Object} client - PostgreSQL client
 * @param {string} mode - "vTours" or "openHouses" to determine what to fetch
 * @returns {Array|null} Array of tour/open house objects or null
 *
 * NOTE: There's a bug in the switch statement - both cases use "vTours"
 */
async function checkTourAndOpenDetails(listing, listingFieldToCheck, rawToCheck, detailsInDb, client, mode){
    let detailsToReturn = null;
    if(listingFieldToCheck > 0){ //we have virtual tours - check the db first
        let detailsRaw;

        if(detailsInDb){
            detailsRaw = rawToCheck;
        }else{
            detailsRaw = [];
        }

        let detailsRetrieved = checkPhotoTourResFromDb(detailsRaw);
        //console.log(`${mode} detail Data Retrieved from Db`);
        //console.log(detailsRetrieved);
        detailsToReturn = detailsRetrieved;

        if (Array.isArray(detailsRetrieved) && detailsRetrieved.length === 0) { //we don't have virtual tours in the db - go to the API
            console.log(`${mode} Retrieved data from API`);
            let dataFromApi;
            let fieldToUpdate;
            let fieldTimestampToUpdate;
            switch(mode){
                case "vTours":
                    dataFromApi = await getVrTours(listing.id); //call API
                    fieldToUpdate = 'virtual_tours';
                    fieldTimestampToUpdate = 'virtual_tours_edited';
                break;
                case "vTours":
                    dataFromApi = await getVrTours(listing.id); //call API
                    fieldToUpdate = 'open_houses';
                    fieldTimestampToUpdate = 'open_houses_edited';
                break;
                default:
            }

            
            let dataFromApiChecked = checkPhotoTourResFromDb(dataFromApi); //check results of the API
            if (Array.isArray(dataFromApiChecked) && dataFromApiChecked.length > 0){
                let myDetailData = dataFromApiChecked;
                //vrTours = vTours; //REMOVE - CLEAN THIS UP 
                let insertDetailDataResultCount = await insertPhotosOpensToursToDb(listing.id, fieldToUpdate, fieldTimestampToUpdate, myDetailData, client, 'update');
                console.log(`${mode} Rows update affected: ${insertDetailDataResultCount}`);
                detailsToReturn = myDetailData;
            }
        }
    }
    return detailsToReturn
}

/**
 * checkPhotoTourResFromDb - Parse cached data from database
 * -----------------------------------------------------------------------------
 * Handles the different formats data might be stored in:
 * - String (JSON string that needs parsing)
 * - Object (already parsed, ready to use)
 * - Null/undefined (return empty array)
 *
 * @param {*} dataRaw - Data retrieved from database (string, object, or null)
 * @returns {Array} Parsed array of photo/tour objects
 */
function checkPhotoTourResFromDb(dataRaw){
    let myRetrieved = null;
    if (typeof dataRaw === 'string') {
        myRetrieved = JSON.parse(dataRaw);
    } else if (typeof dataRaw === 'object' && dataRaw !== null) {
        myRetrieved = dataRaw;  // Already an object, no need to parse
    } else {
        myRetrieved = [];
    }
    return myRetrieved;
}

/**
 * insertPhotosOpensToursToDb - Save API data to database cache
 * -----------------------------------------------------------------------------
 * Inserts or updates photos/tours/open houses in mls_properties_details table.
 * Uses parameterized queries to prevent SQL injection.
 *
 * @param {string} mlsid - The MLS listing ID
 * @param {string} field - Database column name ('photos', 'virtual_tours', 'open_houses')
 * @param {string} updated_field - Timestamp column name ('photos_edited', etc.)
 * @param {Array} dataToInsert - Data to save (will be JSON stringified)
 * @param {Object} client - PostgreSQL client
 * @param {string} mode - 'insert' for new rows, 'update' for existing rows
 * @returns {number} Number of rows affected (0 on error)
 *
 * DATABASE TABLE: mls_properties_details
 * This table caches Spark API responses to reduce external API calls.
 */
async function insertPhotosOpensToursToDb(mlsid, field, updated_field, dataToInsert, client, mode) {
    console.log("--------------🚀 IN db.js - insertPhotosOpensToursToDb function");

    let dataForDb = JSON.stringify(dataToInsert);  // Convert to JSON string for JSONB column
    let detailsObject;
    let detailsQuery;

    try {
        switch (mode) {
            case "insert":
                // Create new row for this listing
                detailsQuery = `
                INSERT INTO mls_properties_details (mlsid, ${field}, time_entered, ${updated_field})
                VALUES ($1, $2::JSONB, NOW(), NOW())`;
                detailsObject = [mlsid, dataForDb];
                break;

            case "update":
                // Update existing row with new data
                detailsQuery = `
                UPDATE mls_properties_details
                SET ${field} = $1::JSONB, ${updated_field} = NOW()
                WHERE mlsid = $2`;
                detailsObject = [dataForDb, mlsid];
                break;

            default:
                console.error("Invalid mode provided to insertPhotosOpensToursToDb:", mode);
                return 0;
        }

        const detailInsertResult = await client.query(detailsQuery, detailsObject);
        return detailInsertResult.rowCount;

    } catch (error) {
        console.error("Error executing insertPhotosOpensToursToDb:", error);
        return 0;
    }
}

/**
 * formatListings - Basic HTML formatter (LEGACY)
 * -----------------------------------------------------------------------------
 * Converts listing data to simple HTML cards.
 * Uses a predictable image URL pattern from Spark CDN.
 *
 * NOTE: Legacy function - not currently used by the main application.
 * The frontend (form.html) handles its own rendering.
 *
 * @param {Array} listingData - Array of property objects
 * @returns {string} HTML string of formatted listings
 */
async function formatListings(listingData) {
    console.log("--------------🚀 IN db.js - formatListings function");

    let formattedListings = listingData.map(listing => {
        let formattedPrice = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(listing.currentprice);

        // Construct predictable image URL from Spark CDN
        let imageUrl = `https://cdn.resize.sparkplatform.com/cab/640x480/true/${listing.id}-o.jpg`;
        const myListingJson = jsonToHtml(listing);

        return `
            <div class="listing" style="display: flex; align-items: flex-start; margin-bottom: 20px;">
                <img src="${imageUrl}" alt="Property Image" style="margin-right: 20px; width: 150px; height: 100px; object-fit: cover;">
                <div>
                    <p><strong>ID:</strong> ${listing.id}</p>
                    <p><strong>MLS Area Major:</strong> ${listing.mlsareamajor}</p>
                    <p><strong>Current Public Price:</strong> ${formattedPrice}</p>
                    <p><strong>Property Type Label:</strong> ${listing.propertyclass} ${listing.propertytypelabel}</p>
                    <p><strong>Public Remarks:</strong> ${listing.publicremarks}</p>
                    <p><strong>Latitude, Longitude::</strong> (${listing.latitude}, ${listing.longitude})</p>
                </div>
            </div>
        `;
    });

    return formattedListings.join('');
}

// =============================================================================
// EXPRESS ROUTER ENDPOINTS (LEGACY - NOT CURRENTLY MOUNTED)
// =============================================================================
/**
 * These router endpoints are defined but the router is not mounted in index.js.
 * They appear to be legacy/placeholder code for future use.
 */

router.get('/properties', async (req, res) => {
    console.log("--------------🚀 IN db.js - /properties get endpoint");
    try {
        // Placeholder - not implemented
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
    console.log('hello');
});

router.post('/properties/trimmed', async (req, res) => {
    console.log("--------------🚀 IN db.js - /properties/trimmed post endpoint");
    try {
        // Placeholder for data migration to trimmed table
        await client.query(`
            INSERT INTO mls_properties_trimmed (column1, column2, ...)
            SELECT column1, column2, ...
            FROM mls_properties
        `);
        res.status(201).json({ message: 'Data transferred to mls_properties_trimmed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// MODULE EXPORTS
// =============================================================================
/**
 * Export functions for use in index.js
 * - router: Express router (currently unused)
 * - formatListings: Legacy HTML formatter
 * - formatListingsMap: Legacy map page generator
 * - formatListingsRaw: PRIMARY function - returns JSON with photos/tours
 */
module.exports = { router, formatListings, formatListingsMap, formatListingsRaw };
