// Copyright (c) 2026 cwcinc. All rights reserved. Unauthorized use prohibited.

class TrackBackupManager {
  constructor() {
    this.storage = new BetterPolyTrackStorage("TrackBackups");
  }
  async backupTrack(trackName, exportCode) {
    const value = {
      name: trackName,
      data: exportCode
    }
    await this.storage.setItem(trackName, value);
  }
  async getBackup(trackName) {
    const item = await this.storage.getItem(trackName);
    if (!item) return null;
    return item.data;
  }
  async close() {
    await this.storage.closeDatabase();
  }
}