// src/recording/meeting-lock.ts

/** navigator.locks のうち、会議ロックで使う部分。LockManager が構造的に満たす（テストでは差し替える）。 */
export interface MeetingLockManager {
  request(name: string, options: { ifAvailable: true }, callback: (lock: Lock | null) => Promise<void>): Promise<void>;
}

/** 録音中の会議を示す Web Lock の名前。保持しているタブが閉じる・落ちるとブラウザが自動で解放する。 */
export function meetingLockName(meetingId: string): string {
  return `minutes:recording:${meetingId}`;
}

/**
 * 会議ロックを待たずに取りにいく。取れたら解放関数を、他（別タブの録音など）が保持中なら null を返す。
 * 解放関数を呼ぶまでロックを保持し続ける。
 */
export function tryAcquireMeetingLock(locks: MeetingLockManager, meetingId: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    locks
      .request(meetingLockName(meetingId), { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(null);
          return Promise.resolve();
        }
        // コールバックの Promise が解決するまでロックは保持される
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(reject);
  });
}
