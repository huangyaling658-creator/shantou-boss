// ════════════════════════════════════════════════════════════════
// 闪投 · 数据访问层
// ────────────────────────────────────────────────────────────────
// 业务代码一律通过 Repo 这个门面访问数据，不直接碰 IndexedDB。
// 将来若需要跨设备同步，加一个 RemoteRepository 换掉实现即可，
// 上层一行不用改（技术方案 2.2「迁移口子」）。
// ════════════════════════════════════════════════════════════════

const DB_NAME = 'jingtou';
const DB_VERSION = 1;

const STORES = {
  JOBS: 'jobs',
  TASKS: 'tasks',
  COMPANIES: 'companies',
  HR_COOLDOWN: 'hrCooldown',
  QUOTA: 'dailyQuota',
};

class IndexedDBRepository {
  constructor() {
    this._db = null;
    this._opening = null;
  }

  /** 并发调用只开一次库 */
  open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;

    this._opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const tx = ev.target.transaction;

        if (!db.objectStoreNames.contains(STORES.JOBS)) {
          const s = db.createObjectStore(STORES.JOBS, { keyPath: 'jobId' });
          // 去重 L2 查指纹
          s.createIndex('fingerprint', 'fingerprint', { unique: false });
          // 去重 L3 只在同公司内比 JD，先按公司缩小范围
          s.createIndex('companyId', 'companyId', { unique: false });
          // 按状态捞待处理队列
          s.createIndex('state', 'state', { unique: false });
          s.createIndex('taskId', 'taskId', { unique: false });
          // 去重 L4 HR 冷却
          s.createIndex('hrId', 'hrId', { unique: false });
          // 审核池按分数排序
          s.createIndex('scoreTotal', 'score.total', { unique: false });
          s.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.TASKS)) {
          const s = db.createObjectStore(STORES.TASKS, { keyPath: 'taskId' });
          s.createIndex('startedAt', 'startedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.COMPANIES)) {
          const s = db.createObjectStore(STORES.COMPANIES, { keyPath: 'id' });
          s.createIndex('group', 'group', { unique: false });
          s.createIndex('brandId', 'brandId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.HR_COOLDOWN)) {
          db.createObjectStore(STORES.HR_COOLDOWN, { keyPath: 'hrId' });
        }

        if (!db.objectStoreNames.contains(STORES.QUOTA)) {
          db.createObjectStore(STORES.QUOTA, { keyPath: 'date' });
        }

        if (tx) tx.oncomplete = () => {};
      };

      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });

    return this._opening;
  }

  async _tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      try { result = fn(os); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('tx_abort'));
    });
  }

  static _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ── jobs ────────────────────────────────────────────────

  async putJob(job) {
    job.updatedAt = Date.now();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.JOBS, 'readwrite');
      tx.objectStore(STORES.JOBS).put(job);
      tx.oncomplete = () => resolve(job);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 批量写。召回一次几百条，逐条开事务太慢 */
  async putJobs(jobs) {
    if (!jobs.length) return 0;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.JOBS, 'readwrite');
      const os = tx.objectStore(STORES.JOBS);
      const now = Date.now();
      for (const j of jobs) { j.updatedAt = now; os.put(j); }
      tx.oncomplete = () => resolve(jobs.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getJob(jobId) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.JOBS).get(jobId));
  }

  /** 去重 L1：这些 jobId 里哪些库里已经有了 */
  async existingJobIds(jobIds) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    const os = tx.objectStore(STORES.JOBS);
    const found = new Set();
    await Promise.all(jobIds.map(async (id) => {
      const key = await IndexedDBRepository._req(os.getKey(id));
      if (key !== undefined) found.add(id);
    }));
    return found;
  }

  /** 去重 L2：这些指纹里哪些库里已经有了 */
  async existingFingerprints(fps) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    const idx = tx.objectStore(STORES.JOBS).index('fingerprint');
    const found = new Set();
    await Promise.all([...new Set(fps)].map(async (fp) => {
      const k = await IndexedDBRepository._req(idx.getKey(fp));
      if (k !== undefined) found.add(fp);
    }));
    return found;
  }

  /** 去重 L3 用：取某公司下已有 JD 的岗位。只在同公司内比，不做全库两两比较 */
  async jobsByCompany(companyId) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    const idx = tx.objectStore(STORES.JOBS).index('companyId');
    return IndexedDBRepository._req(idx.getAll(companyId));
  }

  async jobsByState(state) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    const idx = tx.objectStore(STORES.JOBS).index('state');
    return IndexedDBRepository._req(idx.getAll(state));
  }

  async jobsByTask(taskId) {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    const idx = tx.objectStore(STORES.JOBS).index('taskId');
    return IndexedDBRepository._req(idx.getAll(taskId));
  }

  async allJobs() {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.JOBS).getAll());
  }

  async countJobs() {
    const db = await this.open();
    const tx = db.transaction(STORES.JOBS, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.JOBS).count());
  }

  // ── tasks ───────────────────────────────────────────────

  async putTask(task) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TASKS, 'readwrite');
      tx.objectStore(STORES.TASKS).put(task);
      tx.oncomplete = () => resolve(task);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getTask(taskId) {
    const db = await this.open();
    const tx = db.transaction(STORES.TASKS, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.TASKS).get(taskId));
  }

  async allTasks() {
    const db = await this.open();
    const tx = db.transaction(STORES.TASKS, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.TASKS).getAll());
  }

  // ── companies ───────────────────────────────────────────

  async putCompanies(companies) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.COMPANIES, 'readwrite');
      const os = tx.objectStore(STORES.COMPANIES);
      for (const c of companies) os.put(c);
      tx.oncomplete = () => resolve(companies.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async allCompanies() {
    const db = await this.open();
    const tx = db.transaction(STORES.COMPANIES, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.COMPANIES).getAll());
  }

  async getCompany(id) {
    const db = await this.open();
    const tx = db.transaction(STORES.COMPANIES, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.COMPANIES).get(id));
  }

  // ── HR 冷却（去重 L4）────────────────────────────────────

  async touchHr(hrId, companyId) {
    if (!hrId) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.HR_COOLDOWN, 'readwrite');
      tx.objectStore(STORES.HR_COOLDOWN).put({ hrId, companyId, lastContactAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 返回仍在冷却期内的 hrId 集合 */
  async hrInCooldown(hrIds, windowMs) {
    const db = await this.open();
    const tx = db.transaction(STORES.HR_COOLDOWN, 'readonly');
    const os = tx.objectStore(STORES.HR_COOLDOWN);
    const now = Date.now();
    const out = new Set();
    await Promise.all([...new Set(hrIds.filter(Boolean))].map(async (id) => {
      const rec = await IndexedDBRepository._req(os.get(id));
      if (rec && now - rec.lastContactAt < windowMs) out.add(id);
    }));
    return out;
  }

  // ── 每日额度 ────────────────────────────────────────────

  async getQuota(date) {
    const db = await this.open();
    const tx = db.transaction(STORES.QUOTA, 'readonly');
    const rec = await IndexedDBRepository._req(tx.objectStore(STORES.QUOTA).get(date));
    return rec || { date, sentCount: 0, actualLimit: null, riskCount: 0 };
  }

  async putQuota(quota) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.QUOTA, 'readwrite');
      tx.objectStore(STORES.QUOTA).put(quota);
      tx.oncomplete = () => resolve(quota);
      tx.onerror = () => reject(tx.error);
    });
  }

  async allQuota() {
    const db = await this.open();
    const tx = db.transaction(STORES.QUOTA, 'readonly');
    return IndexedDBRepository._req(tx.objectStore(STORES.QUOTA).getAll());
  }

  // ── 导出 / 导入 ─────────────────────────────────────────
  // 本地库唯一的风险是「清浏览器数据全没了」。导出成本极低，必须有。

  async exportAll() {
    const [jobs, tasks, companies, quota] = await Promise.all([
      this.allJobs(), this.allTasks(), this.allCompanies(), this.allQuota(),
    ]);
    return {
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      counts: { jobs: jobs.length, tasks: tasks.length, companies: companies.length },
      data: { jobs, tasks, companies, quota },
    };
  }

  async importAll(dump) {
    const d = dump?.data;
    if (!d) throw new Error('bad_dump');
    if (d.jobs?.length) await this.putJobs(d.jobs);
    if (d.companies?.length) await this.putCompanies(d.companies);
    for (const t of d.tasks || []) await this.putTask(t);
    for (const q of d.quota || []) await this.putQuota(q);
    return dump.counts || {};
  }
}

const Repo = new IndexedDBRepository();
