import type { DeviceDto } from '../dto/request/device.request.js';
import type { DeviceInfo } from '../services/device.service.js';

/**
 * Maps the snake_case device payload from the client into the camelCase
 * `DeviceInfo` domain shape the services expect. Pure function — no DI, no
 * side effects. Symmetric with the response mappers (the only inbound
 * snake_case → camelCase translation point for the device sub-object).
 *
 * `lastIp` is not part of the client payload; the controller/service adds it
 * from the request, so it's intentionally omitted here.
 */
export const DeviceRequestMapper = {
  toDomain(dto: DeviceDto): DeviceInfo {
    return {
      platform:    dto.platform,
      appVersion:  dto.app_version,
      osVersion:   dto.os_version,
      model:       dto.model,
      publicKey:   dto.public_key,
      pushToken:   dto.push_token,
      attestation: dto.attestation,
    };
  },
};
