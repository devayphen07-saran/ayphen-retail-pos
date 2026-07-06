import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { validateMatrixIntegrity } from './matrix-integrity.validator.js';
import { ENTITIES, SPECIAL_ACTIONS } from './permission-matrix.constants.js';

/**
 * Validates the RBAC permission matrix (rbac.md §5) on module initialization.
 * A violation throws in onModuleInit, which aborts NestFactory bootstrap —
 * the server never begins listening with a broken matrix.
 */
@Injectable()
export class MatrixIntegrityBootstrap implements OnModuleInit {
  private readonly logger = new Logger(MatrixIntegrityBootstrap.name);

  onModuleInit(): void {
    validateMatrixIntegrity();
    const specialCount = Object.values(SPECIAL_ACTIONS).reduce(
      (n, actions) => n + (actions?.length ?? 0),
      0,
    );
    this.logger.log(
      `Permission matrix validated: ${ENTITIES.length} entities, ${specialCount} special actions.`,
    );
  }
}
