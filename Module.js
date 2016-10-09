var Op = require("./Op");

function Module(id) {
    this.id = id;
  this.init = function() {
      console.log("hello", this.goodbye(), " " , this.id);
    return 'hello!';
};

  this.goodbye = function() {
    return 'goodbye!';
};
}

module.exports = Module;