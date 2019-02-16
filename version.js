function getKonataInfo(){

    let packageInfo = require("./package.json");

    return {
        about: `Konata ver ${packageInfo.version}, Kojiro Izuoka and Ryota Shioya.`
    };
}

module.exports.getKonataInfo = getKonataInfo;
