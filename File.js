var fs = require("fs");
function File (path) {
    if (path == null) {
        // error;
        return;
    }
    this.path = path;
    this.buf = fs.readFileSync(path);

    this.IsText = function () {
        return true;
    };
}

module.exports = File;
