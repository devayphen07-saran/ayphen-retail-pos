import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { parse } from '#common/validation/parse.js';
import { MobileJwtGuard } from '#auth/mobile/guards/mobile-jwt.guard.js';
import { CurrentUser, StoreContext } from '#common/rbac/decorators/rbac.decorators.js';
import type { MobilePrincipal } from '#common/types/principal.js';
import { StoreService } from './store.service.js';
import { CreateStoreDtoSchema } from './dto/create-store.dto.js';
import { StoreResponseMapper } from './store.mapper.js';
import type { StoreResponse } from './dto/store.response.js';

@Controller('stores')
@UseGuards(MobileJwtGuard)
export class StoreController {
  constructor(private readonly stores: StoreService) {}

  /**
   * Create a store (subscription.md §8, device F0). Account-level action: gated
   * by ownership + max_stores in the service, not store RBAC — @StoreContext('none')
   * marks it store-unscoped so the route validator is satisfied.
   */
  @Post()
  @StoreContext('none')
  async create(
    @CurrentUser() user: MobilePrincipal,
    @Body() body: unknown,
  ): Promise<StoreResponse> {
    const dto = parse(body, CreateStoreDtoSchema);
    const store = await this.stores.createStore(user.userId, {
      name:      dto.name,
      gstNumber: dto.gst_number,
      address:   dto.address,
      phone:     dto.phone,
      email:     dto.email,
    });
    return StoreResponseMapper.toResponse(store);
  }
}
