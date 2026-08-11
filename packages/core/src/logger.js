import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE_PATH = path.join(__dirname, '..', 'server.log');
const DEBUG_LOG_PATH = path.join(__dirname, '..', 'debug_log.txt');
const ERROR_LOG_PATH = path.join(__dirname, '..', 'error.log');

/**
 * Log levels
 */
export const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

/**
 * Logger configuration
 */
let config = {
    level: LogLevel.INFO,
    enableConsole: true,
    enableFile: true,
    enableDebugFile: true,
    enableErrorFile: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
};

/**
 * Logger utility for the MCP server.
 * Provides info, error, warn, and debug logging with file output and log rotation.
 */
export const Logger = {
    /**
     * Sets the logger configuration.
     * @param {Partial<typeof config>} newConfig - Configuration options
     */
    configure(newConfig) {
        config = { ...config, ...newConfig };
    },

    /**
     * Gets the current logger configuration.
     * @returns {typeof config} Current configuration
     */
    getConfig() {
        return { ...config };
    },

    /**
     * Formats a log message with timestamp and level.
     * @param {number} level - Log level
     * @param {string} message - Message to format
     * @returns {string} Formatted log message
     */
    _formatMessage(level, message) {
        const timestamp = new Date().toISOString();
        const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'UNKNOWN';
        return `[${timestamp}] [${levelName}] ${message}`;
    },

    /**
     * Writes a message to a log file with rotation support.
     * @param {string} filePath - Path to the log file
     * @param {string} message - Message to write
     * @returns {Promise<void>}
     */
    async _writeToFile(filePath, message) {
        if (!config.enableFile) return;

        try {
            // Check file size and rotate if needed
            try {
                const stats = await fs.stat(filePath);
                if (stats.size > config.maxFileSize) {
                    await this._rotateLogFile(filePath);
                }
            } catch {
                // File doesn't exist yet, that's fine
            }

            await fs.appendFile(filePath, message + '\n');
        } catch (e) {
            if (config.enableConsole) {
                console.error(`Failed to write to log file ${filePath}:`, e);
            }
        }
    },

    /**
     * Rotates a log file by renaming it with a timestamp.
     * @param {string} filePath - Path to the log file
     * @returns {Promise<void>}
     */
    async _rotateLogFile(filePath) {
        try {
            const dir = path.dirname(filePath);
            const basename = path.basename(filePath, path.extname(filePath));
            const ext = path.extname(filePath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedPath = path.join(dir, `${basename}.${timestamp}${ext}`);

            await fs.rename(filePath, rotatedPath);

            // Clean up old log files
            const files = await fs.readdir(dir);
            const logFiles = files
                .filter(f => f.startsWith(basename) && f.endsWith(ext))
                .map(f => ({
                    name: f,
                    path: path.join(dir, f),
                }))
                .sort((a, b) => b.name.localeCompare(a.name));

            // Keep only maxFiles number of log files
            for (let i = config.maxFiles; i < logFiles.length; i++) {
                await fs.unlink(logFiles[i].path).catch(() => {});
            }
        } catch (e) {
            if (config.enableConsole) {
                console.error(`Failed to rotate log file ${filePath}:`, e);
            }
        }
    },

    /**
     * Logs a debug message (only to file, not console by default).
     * @param {string} message - Debug message
     * @param {...unknown} args - Additional arguments to log
     * @returns {Promise<void>}
     */
    async debug(message, ...args) {
        if (config.level > LogLevel.DEBUG) return;

        const formattedMessage = this._formatMessage(LogLevel.DEBUG, message + (args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : ''));

        if (config.enableConsole && config.level <= LogLevel.DEBUG) {
            console.debug(formattedMessage);
        }

        if (config.enableDebugFile) {
            await this._writeToFile(DEBUG_LOG_PATH, formattedMessage);
        }
    },

    /**
     * Logs an info message.
     * @param {string} message - Message to log
     * @param {...unknown} args - Additional arguments to log
     * @returns {Promise<void>}
     */
    async info(message, ...args) {
        if (config.level > LogLevel.INFO) return;

        const formattedMessage = this._formatMessage(LogLevel.INFO, message + (args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : ''));

        if (config.enableConsole) {
            console.error(formattedMessage);
        }

        await this._writeToFile(LOG_FILE_PATH, formattedMessage);
    },

    /**
     * Logs a warning message.
     * @param {string} message - Warning message
     * @param {...unknown} args - Additional arguments to log
     * @returns {Promise<void>}
     */
    async warn(message, ...args) {
        if (config.level > LogLevel.WARN) return;

        const formattedMessage = this._formatMessage(LogLevel.WARN, message + (args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : ''));

        if (config.enableConsole) {
            console.warn(formattedMessage);
        }

        await this._writeToFile(LOG_FILE_PATH, formattedMessage);
    },

    /**
     * Logs an error message.
     * @param {string} message - Error message
     * @param {Error | unknown} error - Error object or value
     * @param {...unknown} args - Additional arguments to log
     * @returns {Promise<void>}
     */
    async error(message, error, ...args) {
        if (config.level > LogLevel.ERROR) return;

        const errorStack = error instanceof Error ? error.stack : String(error);
        const formattedMessage = this._formatMessage(LogLevel.ERROR, `${message}: ${errorStack}` + (args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : ''));

        if (config.enableConsole) {
            console.error(formattedMessage);
        }

        await this._writeToFile(LOG_FILE_PATH, formattedMessage);
        if (config.enableErrorFile) {
            await this._writeToFile(ERROR_LOG_PATH, formattedMessage);
        }
    },

    /**
     * Creates a child logger with a prefix.
     * @param {string} prefix - Prefix to add to all log messages
     * @returns {typeof Logger} Child logger instance
     */
    child(prefix) {
        return {
            debug: (message, ...args) => this.debug(`[${prefix}] ${message}`, ...args),
            info: (message, ...args) => this.info(`[${prefix}] ${message}`, ...args),
            warn: (message, ...args) => this.warn(`[${prefix}] ${message}`, ...args),
            error: (message, error, ...args) => this.error(`[${prefix}] ${message}`, error, ...args),
        };
    },
};
