"use strict";

// パーサ単体テストを実ファイルや非同期I/Oから切り離すためのFileReader代替。
// 読み出し量も再現し、進捗計算を含むsetFileの契約をそのまま通す。
class FakeFileReader {
    constructor(text, filePath = "memory.txt") {
        this.filePath_ = filePath;
        this.lines_ = text.split(/\r?\n/);
        if (this.lines_[this.lines_.length - 1] === "") {
            this.lines_.pop();
        }

        this.fileSize_ = Buffer.byteLength(text);
        this.bytesRead_ = 0;
        this.closed_ = false;
    }

    close() {
        // パーサ切り替え時にcloseされた後は、残りの行とfinishを通知しない。
        this.closed_ = true;
    }

    getPath() {
        return this.filePath_;
    }

    readlines(read, finish) {
        // 一時ファイルを作らず、実装のFileReaderと同じコールバック契約を再現する。
        for (const line of this.lines_) {
            if (this.closed_) {
                return;
            }
            this.bytesRead_ += Buffer.byteLength(line) + 1;
            read(line);
        }

        if (!this.closed_) {
            this.bytesRead_ = this.fileSize_;
            finish();
        }
    }

    get fileSize() {
        return this.fileSize_;
    }

    get bytesRead() {
        return Math.min(this.bytesRead_, this.fileSize_);
    }
}

function parseText(parser, text) {
    const reader = new FakeFileReader(text);
    return new Promise((resolve, reject) => {
        // KonataはfileNotSupportで次のパーサを試すか判断するため、この値を失わず
        // フォールバック処理までテストできるようにする。
        parser.setFile(
            reader,
            () => {},
            () => resolve(parser),
            (fileNotSupport, error) => {
                const reason = error instanceof Error ? error : new Error(String(error ?? "Unsupported file format."));
                reason.fileNotSupport = fileNotSupport;
                reject(reason);
            }
        );
    });
}

async function withoutConsoleLog(body) {
    // 正常系でパーサが出す計測ログを抑え、TAPの結果を読みやすく保つ。
    const originalLog = console.log;
    console.log = () => {};
    try {
        return await body();
    }
    finally {
        console.log = originalLog;
    }
}

module.exports.FakeFileReader = FakeFileReader;
module.exports.parseText = parseText;
module.exports.withoutConsoleLog = withoutConsoleLog;
