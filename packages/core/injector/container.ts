import { DynamicModule, Provider } from '@nestjs/common';
import { GLOBAL_MODULE_METADATA } from '@nestjs/common/constants';
import { Injectable } from '@nestjs/common/interfaces/injectable.interface';
import { Type } from '@nestjs/common/interfaces/type.interface';
import { ApplicationConfig } from '../application-config';
import {
  CircularDependencyException,
  UndefinedForwardRefException,
  UnknownModuleException,
} from '../errors/exceptions';
import { REQUEST } from '../router/request/request-constants';
import { ModuleCompiler } from './compiler';
import { ContextId } from './instance-wrapper';
import { InternalCoreModule } from './internal-core-module';
import { InternalProvidersStorage } from './internal-providers-storage';
import { Module } from './module';
import { ModuleTokenFactory } from './module-token-factory';
import { ModulesContainer } from './modules-container';

export class NestContainer {
  private readonly globalModules = new Set<Module>();
  private readonly moduleTokenFactory = new ModuleTokenFactory();
  private readonly moduleCompiler = new ModuleCompiler(this.moduleTokenFactory);
  private readonly modules = new ModulesContainer();
  private readonly dynamicModulesMetadata = new Map<
    string,
    Partial<DynamicModule>
  >();
  private readonly internalProvidersStorage = new InternalProvidersStorage();
  private internalCoreModule: Module;

  constructor(
    private readonly _applicationConfig: ApplicationConfig = undefined,
  ) {}

  get applicationConfig(): ApplicationConfig | undefined {
    return this._applicationConfig;
  }

  public setHttpAdapter(httpAdapter: any) {
    this.internalProvidersStorage.httpAdapter = httpAdapter;

    if (!this.internalProvidersStorage.httpAdapterHost) {
      return;
    }
    const host = this.internalProvidersStorage.httpAdapterHost;
    host.httpAdapter = httpAdapter;
  }

  public getHttpAdapterRef() {
    return this.internalProvidersStorage.httpAdapter;
  }

  public getHttpAdapterHostRef() {
    return this.internalProvidersStorage.httpAdapterHost;
  }

  public async addModule(
    metatype: Type<any> | DynamicModule | Promise<DynamicModule>,
    scope: Type<any>[],
  ): Promise<Module | undefined> {
    // In DependenciesScanner#scanForModules we already check for undefined or invalid modules
    // We still need to catch the edge-case of `forwardRef(() => undefined)`
    if (!metatype) {
      throw new UndefinedForwardRefException(scope);
    }
    const { type, dynamicMetadata, token } = await this.moduleCompiler.compile(
      metatype,
    );
    if (this.modules.has(token)) {
      return this.modules.get(token);
    }
    const moduleRef = new Module(type, this);
    moduleRef.token = token;
    this.modules.set(token, moduleRef);

    await this.addDynamicMetadata(
      token,
      dynamicMetadata,
      [].concat(scope, type),
    );

    if (this.isGlobalModule(type, dynamicMetadata)) {
      this.addGlobalModule(moduleRef);
    }
    return moduleRef;
  }

  public async addDynamicMetadata(
    token: string,
    dynamicModuleMetadata: Partial<DynamicModule>,
    scope: Type<any>[],
  ) {
    if (!dynamicModuleMetadata) {
      return;
    }
    this.dynamicModulesMetadata.set(token, dynamicModuleMetadata);

    const { imports } = dynamicModuleMetadata;
    await this.addDynamicModules(imports, scope);
  }

  public async addDynamicModules(modules: any[], scope: Type<any>[]) {
    if (!modules) {
      return;
    }
    await Promise.all(modules.map(module => this.addModule(module, scope)));
  }

  public isGlobalModule(
    metatype: Type<any>,
    dynamicMetadata?: Partial<DynamicModule>,
  ): boolean {
    if (dynamicMetadata && dynamicMetadata.global) {
      return true;
    }
    return !!Reflect.getMetadata(GLOBAL_MODULE_METADATA, metatype);
  }

  public addGlobalModule(module: Module) {
    this.globalModules.add(module);
  }

  public getModules(): ModulesContainer {
    return this.modules;
  }

  public getModuleCompiler(): ModuleCompiler {
    return this.moduleCompiler;
  }

  public getModuleByKey(moduleKey: string): Module {
    return this.modules.get(moduleKey);
  }

  public getInternalCoreModuleRef(): Module | undefined {
    return this.internalCoreModule;
  }

  public async addImport(
    relatedModule: Type<any> | DynamicModule,
    token: string,
  ) {
    if (!this.modules.has(token)) {
      return;
    }
    const moduleRef = this.modules.get(token);
    const { token: relatedModuleToken } = await this.moduleCompiler.compile(
      relatedModule,
    );
    const related = this.modules.get(relatedModuleToken);
    moduleRef.addRelatedModule(related);
  }

  public addProvider(
    provider: Provider,
    token: string,
  ): string | symbol | Function {
    const moduleRef = this.modules.get(token);
    if (!provider) {
      throw new CircularDependencyException(moduleRef?.metatype.name);
    }
    if (!moduleRef) {
      throw new UnknownModuleException();
    }
    return moduleRef.addProvider(provider);
  }

  public addInjectable(
    injectable: Provider,
    token: string,
    host?: Type<Injectable>,
  ) {
    if (!this.modules.has(token)) {
      throw new UnknownModuleException();
    }
    const moduleRef = this.modules.get(token);
    moduleRef.addInjectable(injectable, host);
  }

  public addExportedProvider(provider: Type<any>, token: string) {
    if (!this.modules.has(token)) {
      throw new UnknownModuleException();
    }
    const moduleRef = this.modules.get(token);
    moduleRef.addExportedProvider(provider);
  }

  public addController(controller: Type<any>, token: string) {
    if (!this.modules.has(token)) {
      throw new UnknownModuleException();
    }
    const moduleRef = this.modules.get(token);
    moduleRef.addController(controller);
  }

  public clear() {
    this.modules.clear();
  }

  public replace(toReplace: any, options: any & { scope: any[] | null }) {
    this.modules.forEach(moduleRef => moduleRef.replace(toReplace, options));
  }

  public bindGlobalScope() {
    this.modules.forEach(moduleRef => this.bindGlobalsToImports(moduleRef));
  }

  public bindGlobalsToImports(moduleRef: Module) {
    this.globalModules.forEach(globalModule =>
      this.bindGlobalModuleToModule(moduleRef, globalModule),
    );
  }

  public bindGlobalModuleToModule(target: Module, globalModule: Module) {
    if (target === globalModule || target === this.internalCoreModule) {
      return;
    }
    target.addRelatedModule(globalModule);
  }

  public getDynamicMetadataByToken(
    token: string,
    metadataKey: keyof DynamicModule,
  ) {
    const metadata = this.dynamicModulesMetadata.get(token);
    if (metadata && metadata[metadataKey]) {
      return metadata[metadataKey] as any[];
    }
    return [];
  }

  public registerCoreModuleRef(moduleRef: Module) {
    this.internalCoreModule = moduleRef;
    this.modules[InternalCoreModule.name] = moduleRef;
  }

  public getModuleTokenFactory(): ModuleTokenFactory {
    return this.moduleTokenFactory;
  }

  public registerRequestProvider<T = any>(request: T, contextId: ContextId) {
    const wrapper = this.internalCoreModule.getProviderByKey(REQUEST);
    wrapper.setInstanceByContextId(contextId, {
      instance: request,
      isResolved: true,
    });
  }
}
