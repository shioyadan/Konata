function getKonataInfo(){

    let package = require("./package.json");

    return {
        about: `Konata ver ${package.version}, Kojiro Izuoka and Ryota Shioya.`
    };
}

module.exports.getKonataInfo = getKonataInfo;
