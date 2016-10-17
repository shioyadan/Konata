function Stage (args) {
    this.name = null;
    this.startCycle = null;
    this.endCycle = null;
    for (var key in args) {
        this[key] = args[key];
    }
}

module.exports = Stage;
