const Apify = require('apify');
const cheerio = require("cheerio");
const getDataFromIdnes = require("./idnes");
const toNumber = (str) => {
    return parseInt(str.replace(",", "").replace(" ", ""), 10)
};

const parseDateToUTC = (dateString) => {
    const split = dateString.split(".");
    const date = new Date(`${split[1]}/${split[0]}/${split[2]}`)
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
};

const connectDataFromGraph = (graphData) => {

    return graphData.values.map((value) => ({
        value: value.y,
        date: parseDateToUTC(value.x).toISOString()
    }));
};

const LATEST = "LATEST";

Apify.main(async () => {
    const kvStore = await Apify.openKeyValueStore("COVID-19-CZECH");
    const dataset = await Apify.openDataset("COVID-19-CZECH-HISTORY");

    const response = await Apify.utils.requestAsBrowser({
        url: "https://onemocneni-aktualne.mzcr.cz/covid-19",
        proxyUrl: Apify.getApifyProxyUrl({groups: ["SHADER"]}
        )
    });
    const $ = await cheerio.load(response.body);
    const url = $("#covid-content").attr("data-report-url");
    const totalTested = $("#count-test").text().trim();
    const infected = $("p#count-sick").eq(0).text().trim();
    const recovered = $("#count-recover").text().trim();
    const lastUpdated = $("#last-modified-datetime").text().trim().replace("Poslední aktualizace: ", "").replace(/\u00a0/g, "");
    const parts = lastUpdated.split("v");
    const infectedData = JSON.parse($("#js-cummulative-total-persons-data").attr("data-linechart"));
    const numberOfTestedData = JSON.parse($("#js-cummulative-total-tests-data").attr("data-linechart"));
    const infectedByRegionData = JSON.parse($("#js-region-map-data").attr("data-map"));
    const infectedDailyData = JSON.parse($("#js-total-persons-data").attr("data-barchart"));
    const regionQuarantineData = JSON.parse($("#js-region-quarantine-data").attr("data-barchart") || "[]");
    const regionQuarantine = regionQuarantineData.map(val => ({
        reportDate: parseDateToUTC(val.key.replace("Hlášení k ", "")).toISOString(),
        regionData: val.values.map(({x, y}) => ({regionName: x, value: y}))
    }));
    const sourceOfInfectionData = JSON.parse($("#js-total-foreign-countries-data").attr("data-barchart"));
    const sexAgeData = JSON.parse($("#js-total-sex-age-data").attr("data-barchart"));
    const protectionSuppliesSummaryTable = $(".static-table__container table");

    // Table with supplies
    const headers = [];
    const tableData = [];
    $(protectionSuppliesSummaryTable).find("thead th").each((idex, element)=>{
        headers.push($(element).text().trim())
    });
    $(protectionSuppliesSummaryTable).find("tbody tr").each((index, element)=>{
        const rowData = {};
        $(element).find("td").each((i, el)=>{
            if(i>=1) {
                rowData[headers[i]] = toNumber($(el).text().trim());
            }else{
                rowData[headers[i]] = $(el).text().trim();
            }
        });
        tableData.push(rowData);
    });

    const splited = parts[0].split(".");
    let lastUpdatedParsed = new Date(`${splited[1]}.${splited[0]}.${splited[2]} ${parts[1].replace("h", "").replace(".", ":")}`);
    lastUpdatedParsed = new Date(Date.UTC(lastUpdatedParsed.getFullYear(), lastUpdatedParsed.getMonth(), lastUpdatedParsed.getDate(), lastUpdatedParsed.getHours() - 1, lastUpdatedParsed.getMinutes()));

    const now = new Date();
    const data = {
        totalTested: toNumber(totalTested),
        infected: toNumber(infected),
        recovered: toNumber(recovered),
        totalPositiveTests: connectDataFromGraph(infectedData),
        numberOfTestedGraph: connectDataFromGraph(numberOfTestedData),
        infectedByRegion: infectedByRegionData.map(({name, value}) => ({name, value})),
        infectedDaily: connectDataFromGraph(infectedDailyData),
        regionQuarantine,
        countryOfInfection: sourceOfInfectionData.values.map((value) => ({countryName: value.x, value: value.y})),
        infectedByAgeSex: sexAgeData.map((sexData) => ({
            sex: sexData.key,
            infectedByAge: sexData.values.map(({x, y}) => ({
                age: x,
                value: y,
            })),
        })),
       // protectionSuppliesSummary: tableData,
        sourceUrl: url,
        lastUpdatedAtSource: lastUpdatedParsed.toISOString(),
        lastUpdatedAtApify: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString(),
        readMe: "https://apify.com/petrpatek/covid-cz",
    };

    // Data from idnes - They have newer numbers than MZCR...
    const idnesData = await getDataFromIdnes();
    data.fromBabisNewspapers = {
        ...idnesData
    };


    // Compare and save to history
    let latest = await kvStore.getValue(LATEST);
    if (!latest) {
        await kvStore.setValue('LATEST', data);
        latest = data;
    }
    delete latest.lastUpdatedAtApify;
    const actual = Object.assign({}, data);
    delete actual.lastUpdatedAtApify;

    if (JSON.stringify(latest) !== JSON.stringify(actual)) {
        await dataset.pushData(data);
    }

    await kvStore.setValue('LATEST', data);
    await Apify.pushData(data);
    console.log('Done.');
});
