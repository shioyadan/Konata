class Stage{
    constructor(){
        this.name = "";
        /** @type {string} */
        this.labels = "";
        this.startCycle = 0;
        this.endCycle = 0;
    }
}

class StageLevel{
    constructor(){
        this.appearance = 0;    // The order of appearance
        this.unique = 0;        // Different levels are assigned to all levels 
        this.laneID = 0;        // The ID of a lane that this instance belongs
    }
}

class StageLevelMap{
    constructor(){
        /** @type {Object.<string, Object.<string, StageLevel>>} */
        this.map_ = {};
        this.laneID_Map = {};
    }

    get(laneName, stageName){
        return this.map_[laneName][stageName];
    }

    has(laneName, stageName){
        return (laneName in this.map_) && (stageName in this.map_[laneName]);
    }

    /** @param {string} laneName
     * @param {string} stageName
     * @param {Lane} lane
    */
    update(laneName, stageName, lane){
        if (this.has(laneName, stageName)) {
            if (this.map_[laneName][stageName].appearance > lane.level) {
                this.map_[laneName][stageName].appearance = lane.level;
            }
        }
        else{
            if (!(laneName in this.map_)) {
                this.map_[laneName] = {};
                this.laneID_Map[laneName] = Object.keys(this.laneID_Map).length;
            }
            let level = new StageLevel;
            level.appearance = lane.level;
            level.unique = Object.keys(this.map_[laneName]).length;
            level.laneID = this.laneID_Map[laneName];
            this.map_[laneName][stageName] = level;
        }
    }
}

class Lane{
    constructor(){
        this.level = 0;  // 1サイクル以上のステージの数
        /** @type {Array<Stage>} */
        this.stages = [];
    }
}

module.exports.Stage = Stage;
module.exports.StageLevel = StageLevel;
module.exports.StageLevelMap = StageLevelMap;
module.exports.Lane = Lane;

