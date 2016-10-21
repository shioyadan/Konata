function File (path) {
    var m_fs = require("fs");
    var m_buf = null;
    var m_text = null;

    if (path == null) {
        // error;
        return;
    }
    this.path = path;
    this.success = false;

    try {
        if (m_fs.statSync(path)) {
            m_buf = m_fs.readFileSync(path);
            this.success = true;
        }
    } catch(e) {

    }

    this.IsText = function () {
        return true;
    };

    this.GetText = function () {
        if (m_text) {
            return m_text;
        }
        m_text = m_buf.toString();
        return m_text;
    }
}

module.exports = File;
