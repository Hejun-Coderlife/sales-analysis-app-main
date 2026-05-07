export const v2State = {
  activeDatasetId: null,
  latestJob: null,
  latestResults: null,
  loading: false,
  pagination: {
    storeRank: { limit: 300, offset: 0 },
    salespersonRank: { limit: 300, offset: 0 },
    memberRank: { limit: 500, offset: 0 },
    sleepList: { limit: 500, offset: 0 },
  },
  filterOptions: {
    stores: [],
    salespeople: [],
    products: [],
  },
};

export function setDatasetId(datasetId) {
  v2State.activeDatasetId = datasetId || null;
  window.__v2DatasetId = v2State.activeDatasetId;
}

export function setLatestJob(job) {
  v2State.latestJob = job || null;
  window.__v2LastJob = v2State.latestJob;
}

export function setLatestResults(results) {
  v2State.latestResults = results || null;
  window.__v2Results = v2State.latestResults;
}

export function setV2Loading(loading) {
  v2State.loading = !!loading;
  window.__v2Loading = v2State.loading;
}

export function setFilterOptions(options = {}) {
  v2State.filterOptions = {
    stores: Array.isArray(options.stores) ? options.stores : [],
    salespeople: Array.isArray(options.salespeople) ? options.salespeople : [],
    products: Array.isArray(options.products) ? options.products : [],
  };
}
