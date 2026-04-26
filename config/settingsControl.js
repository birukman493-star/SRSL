const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_PATH = path.join(__dirname, 'settings.json');

function getSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE_PATH)) {
            // Setup default setting if missing
            const defaults = { publicRegistrationEnabled: false };
            fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(defaults, null, 2));
            return defaults;
        }
        const data = fs.readFileSync(SETTINGS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading settings file:', error);
        return { publicRegistrationEnabled: false }; // Fail secure
    }
}

function updateSettings(newSettings) {
    try {
        const currentSettings = getSettings();
        const mergedSettings = { ...currentSettings, ...newSettings };
        fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(mergedSettings, null, 2));
        return true;
    } catch (error) {
        console.error('Error updating settings file:', error);
        return false;
    }
}

module.exports = {
    getSettings,
    updateSettings
};
