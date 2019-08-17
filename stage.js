class Stage{
    constructor(){
        this.name = "";
        /** @type {string[]} */
        this.labels = [];
        this.startCycle = 0;
        this.endCycle = 0;
    }
}

class StageLevel{
    constructor(){
        this.appearance = 0;    // The order of appearance
        this.unique = 0;        // Different levels are assigned to all levels 
    }
}

module.exports.Stage = Stage;
module.exports.StageLevel = StageLevel;

