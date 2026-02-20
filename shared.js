const BROADCAST_CHANNEL_NAME = 'live_llm_feed';
const STORAGE_KEY_FEED = 'live_llm_feed_data';
const DB_NAME = 'LiveLLMFeedDB';
const DB_VERSION = 1;
const STORE_NAME = 'feed_items';

// Simple IndexedDB wrapper
class FeedStore {
    constructor() {
        this.db = null;
        this.initPromise = this.init();
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (e) => {
                console.error("IndexedDB error:", e);
                reject(e);
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
        });
    }

    async addItem(item) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(item); // use put to handle both add and update
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e);
        });
    }

    async getAllItems() {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = (e) => reject(e);
        });
    }

    async clear() {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e);
        });
    }
}

// Utility to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Data format:
// {
//   id: string,
//   timestamp: number,
//   type: 'image' | 'text',
//   content: string (dataURL for image, text for text),
//   meta: object (optional)
// }

class FeedManager {
    constructor() {
        this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this.listeners = [];
        this.store = new FeedStore();
        
        this.channel.onmessage = (event) => {
            if (event.data && event.data.type === 'new_item') {
                this.notifyListeners(event.data.item);
            } else if (event.data && event.data.type === 'update_item') {
                this.notifyUpdate(event.data.item);
            } else if (event.data && event.data.type === 'clear') {
                this.notifyClear();
            }
        };
    }

    addListener(callback) {
        this.listeners.push(callback);
    }

    notifyListeners(item) {
        this.listeners.forEach(cb => cb('new_item', item));
    }

    notifyUpdate(item) {
        this.listeners.forEach(cb => cb('update_item', item));
    }
    
    notifyClear() {
        this.listeners.forEach(cb => cb('clear'));
    }

    addItem(item) {
        // Save to IndexedDB (supports images and larger data)
        this.store.addItem(item).catch(e => console.error("Store add error", e));
        
        // Broadcast
        this.channel.postMessage({ type: 'new_item', item });
        this.notifyListeners(item);
    }

    updateItem(item) {
        if (!item || !item.id) return;
        this.store.addItem(item).catch(e => console.error("Store update error", e));

        this.channel.postMessage({ type: 'update_item', item });
        this.notifyUpdate(item);
    }

    clear() {
        this.store.clear().catch(e => console.error("Store clear error", e));
        localStorage.removeItem(STORAGE_KEY_FEED); // Clear legacy localStorage just in case
        this.channel.postMessage({ type: 'clear' });
        this.notifyClear();
    }
    
    async loadHistoryAsync() {
        try {
            const items = await this.store.getAllItems();
            return items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        } catch (e) {
            console.error("Load history error", e);
            return [];
        }
    }

    static loadHistory() {
        // Deprecated synchronous method, kept for backward compat if any
        // Better to use loadHistoryAsync instance method
        try {
            const raw = localStorage.getItem(STORAGE_KEY_FEED);
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }
}

// Simple time formatter
function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

// Export for module usage or global
window.FeedManager = FeedManager;
window.formatTime = formatTime;
