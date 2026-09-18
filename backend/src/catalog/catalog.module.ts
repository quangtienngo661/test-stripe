import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogItem, CatalogItemSchema } from './catalog.schema';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: CatalogItem.name, schema: CatalogItemSchema }])],
  providers: [CatalogService],
  controllers: [CatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
