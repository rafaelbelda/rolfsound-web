# utils/core.py
from utils.bridge.http_client import CoreHttpClient
from utils.bridge.ipc_client import IpcClient
from utils.bridge.core_facade import RolfsoundCoreFacade

# 1. Instanciamos os clientes base
http_client = CoreHttpClient()
ipc_client = IpcClient()

# 2. Criamos o nosso Orquestrador Global
# É esta variável 'core' que todos os endpoints vão importar!
core = RolfsoundCoreFacade(http_client, ipc_client)