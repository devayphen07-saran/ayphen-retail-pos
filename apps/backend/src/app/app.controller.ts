import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from '#common/rbac/decorators/rbac.decorators.js';

@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getData(): { message: string } {
    return this.appService.getData();
  }
}
