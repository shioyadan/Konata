function File (path) {
    // この辺はnodejsの標準ライブラリらすぃ
    var m_fs = require("fs");
    var m_zlib = require('zlib');
    var m_buf = null;
    var m_text = null;
    var m_Path = require('path');
    
    if (path == null) {
        // error;
        return;
    }
    var m_path = path;
    this.success = false;

    try {
        if (m_fs.statSync(path)) {
            m_buf = m_fs.readFileSync(path);
            //console.log(m_buf);
            this.success = true;
        }
    } catch(e) {

    }

    this.GetPath = function () {
        return m_path;
    }

    this.IsText = function () {
        var txts = [".txt",".log",".text"];
        for (var i = 0, len = txts.length; i < len; i++) {
            var ext = txts[i];
            if (this.GetExtension() == ext) {
                console.log("This file is text");
                return true;
            }
        }
        console.log("This file is not text");
        return false;
    };

    this.Extract = function (that) {
        if (this.IsText()) {
            return;
        }
        var state = 0;
        var string = null;
        console.log("gunzip start");
        return new Promise (function (resolve, reject) {
            m_zlib.gunzip(m_buf, function (err, binary) {
                var string = binary.toString('utf-8');
                //console.log(string);
                console.log("Extract");
                state = 1;
                resolve(string, that);
                m_text = string;
            })
        });
    }

    this.AlloewedExension = function () {
        return [".txt", ".text", ".log", ".gz"];
    };

    this.GetText = function () {
        if (m_text) {
            return m_text;
        }
        m_text = m_buf.toString();
        return m_text;
    };

    this.GetExtension = function () {
        var ext = m_Path.extname(m_path);
        return ext;
    };
}

module.exports = File;
