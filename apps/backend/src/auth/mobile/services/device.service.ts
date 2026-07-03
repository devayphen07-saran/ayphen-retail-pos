import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { DbExecutor } from '#db/db.module.js';
import {
  DeviceRepository,
  type Device,
} from '../repositories/device.repository.js';

export interface DeviceInfo {
  publicKey: string;
  platform: 'ios' | 'android' | 'web';
  model?: string;
  osVersion?: string;
  appVersion?: string;
  attestation?: string;
  lastIp?: string;
  pushToken?: string;
}

@Injectable()
export class DeviceService {
  constructor(private readonly deviceRepo: DeviceRepository) {}

  async findById(id: string): Promise<Device | null> {
    return this.deviceRepo.findById(id);
  }

  async upsertDevice(userFk: string, info: DeviceInfo, tx?: DbExecutor): Promise<Device> {
    const publicKeyHash = createHash('sha256')
      .update(info.publicKey)
      .digest('hex');
    const existing = await this.deviceRepo.findByUserAndKeyHash(
      userFk,
      publicKeyHash,
      tx,
    );

    if (existing) {
      const patch = {
        lastSeenAt: new Date(),
        appVersion: info.appVersion,
        osVersion: info.osVersion,
        model: info.model,
        lastIp: info.lastIp,
        pushToken: info.pushToken,
      };
      await this.deviceRepo.update(existing.id, patch, tx);
      // Return the merged view — the previous `{ ...existing, lastSeenAt }`
      // returned stale pre-update values for every other field the caller wrote.
      // Drizzle skips `undefined` on update (column keeps its prior value), so
      // mirror that: only override with values that were actually provided.
      return {
        ...existing,
        lastSeenAt: patch.lastSeenAt,
        appVersion: patch.appVersion ?? existing.appVersion,
        osVersion:  patch.osVersion  ?? existing.osVersion,
        model:      patch.model      ?? existing.model,
        lastIp:     patch.lastIp     ?? existing.lastIp,
        pushToken:  patch.pushToken  ?? existing.pushToken,
      };
    }

    return this.deviceRepo.insert(
      {
        userFk,
        publicKey:           info.publicKey,
        publicKeyHash,
        platform:            info.platform,
        model:               info.model,
        osVersion:           info.osVersion,
        appVersion:          info.appVersion,
        lastIp:              info.lastIp,
        pushToken:           info.pushToken,
        // Flag is stored for future enforcement; not blocked in Phase 1
        attestationVerified: !!info.attestation,
        // Devices start untrusted. Refresh proves device possession via a signed
        // challenge (see refresh-token.service.ts + the refresh/challenge
        // endpoint); a trust path can later set is_trusted to skip that.
      },
      tx,
    );
  }
}