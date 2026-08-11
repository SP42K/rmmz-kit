/**
 * Error codes and error message utilities
 */

/**
 * Error code constants
 */
export const ErrorCodes = {
    // Project validation errors (1000-1099)
    INVALID_PROJECT_PATH: 'E1000',
    PROJECT_NOT_DIRECTORY: 'E1001',
    PROJECT_FILE_NOT_FOUND: 'E1002',
    
    // Map errors (1100-1199)
    MAP_FILE_NOT_FOUND: 'E1100',
    MAP_FILE_READ_ERROR: 'E1101',
    MAP_FILE_WRITE_ERROR: 'E1102',
    EVENT_NOT_FOUND: 'E1103',
    EVENT_PAGE_NOT_FOUND: 'E1104',
    
    // Data file errors (1200-1299)
    DATA_FILE_NOT_FOUND: 'E1200',
    DATA_FILE_READ_ERROR: 'E1201',
    DATA_FILE_WRITE_ERROR: 'E1202',
    DATA_FILE_INVALID_JSON: 'E1203',
    
    // Asset errors (1300-1399)
    ASSET_NOT_FOUND: 'E1300',
    ASSET_PATH_INVALID: 'E1301',
    
    // Plugin errors (1400-1499)
    PLUGIN_FILE_NOT_FOUND: 'E1400',
    PLUGIN_FILE_READ_ERROR: 'E1401',
    PLUGIN_FILE_WRITE_ERROR: 'E1402',
    
    // Validation errors (1500-1599)
    VALIDATION_ERROR: 'E1500',
    INVALID_PARAMETER: 'E1501',
    MISSING_REQUIRED_PARAMETER: 'E1502',
    
    // Runtime errors (1600-1699)
    RUNTIME_ERROR: 'E1600',
    OPERATION_FAILED: 'E1601',
};

/**
 * Custom error class with error code
 */
export class MCPError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'MCPError';
        this.code = code;
        this.details = details;
    }
    
    /**
     * Formats error message with code
     */
    toString() {
        return `[${this.code}] ${this.message}`;
    }
    
    /**
     * Converts to JSON for API responses
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            details: this.details,
        };
    }
}

/**
 * Error message formatter
 */
export const formatError = (code, message, details = {}) => {
    return `[${code}] ${message}`;
};

/**
 * Common error creators
 */
export const Errors = {
    invalidProjectPath: (projectPath, reason) => {
        return new MCPError(
            ErrorCodes.INVALID_PROJECT_PATH,
            `Invalid project path: ${reason}`,
            { projectPath }
        );
    },
    
    projectNotDirectory: (projectPath) => {
        return new MCPError(
            ErrorCodes.PROJECT_NOT_DIRECTORY,
            `Path is not a directory: ${projectPath}`,
            { projectPath }
        );
    },
    
    projectFileNotFound: (projectPath) => {
        return new MCPError(
            ErrorCodes.PROJECT_FILE_NOT_FOUND,
            `Not a valid RPG Maker MZ project (game.rmmzproject not found): ${projectPath}`,
            { projectPath }
        );
    },
    
    mapFileNotFound: (mapId, projectPath) => {
        return new MCPError(
            ErrorCodes.MAP_FILE_NOT_FOUND,
            `Map file not found: Map${String(mapId).padStart(3, '0')}.json`,
            { mapId, projectPath }
        );
    },
    
    mapFileReadError: (mapId, reason) => {
        return new MCPError(
            ErrorCodes.MAP_FILE_READ_ERROR,
            `Failed to read map file: ${reason}`,
            { mapId, reason }
        );
    },
    
    eventNotFound: (eventId, mapId) => {
        return new MCPError(
            ErrorCodes.EVENT_NOT_FOUND,
            `Event ${eventId} not found in Map ${mapId}`,
            { eventId, mapId }
        );
    },
    
    eventPageNotFound: (eventId, pageIndex, mapId) => {
        return new MCPError(
            ErrorCodes.EVENT_PAGE_NOT_FOUND,
            `Page ${pageIndex} not found in Event ${eventId} (Map ${mapId})`,
            { eventId, pageIndex, mapId }
        );
    },
    
    dataFileNotFound: (filename, projectPath) => {
        return new MCPError(
            ErrorCodes.DATA_FILE_NOT_FOUND,
            `Data file not found: ${filename}`,
            { filename, projectPath }
        );
    },
    
    dataFileReadError: (filename, reason) => {
        return new MCPError(
            ErrorCodes.DATA_FILE_READ_ERROR,
            `Failed to read data file ${filename}: ${reason}`,
            { filename, reason }
        );
    },
    
    dataFileWriteError: (filename, reason) => {
        return new MCPError(
            ErrorCodes.DATA_FILE_WRITE_ERROR,
            `Failed to write data file ${filename}: ${reason}`,
            { filename, reason }
        );
    },
    
    invalidParameter: (parameterName, reason) => {
        return new MCPError(
            ErrorCodes.INVALID_PARAMETER,
            `Invalid parameter '${parameterName}': ${reason}`,
            { parameterName, reason }
        );
    },
    
    missingRequiredParameter: (parameterName) => {
        return new MCPError(
            ErrorCodes.MISSING_REQUIRED_PARAMETER,
            `Missing required parameter: ${parameterName}`,
            { parameterName }
        );
    },

    assetPathInvalid: (path) => {
        return new MCPError(
            ErrorCodes.ASSET_PATH_INVALID,
            `Invalid asset path (path traversal detected): ${path}`,
            { path }
        );
    },
};

