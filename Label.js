function Label (args) {
    this.text = null;
    this.visible = 0;
    for (var key in args) {
        this[key] = args[key];
    }
}

module.exports = Label;
