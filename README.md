![Logo](admin/tion_lite.png)
# ioBroker.tion_lite

BLE-драйвер Tion BR_LITE для ioBroker на Linux. Один бризер на экземпляр адаптера.
Реализован на TypeScript. Bluetooth работает через `@stoprocent/noble` в отдельном
дочернем процессе — по подходу адаптера ioBroker.ble.

## Возможности

- Получение имени, Bluetooth-адреса и версии прошивки (число и hex).
- Включение и выключение бризера.
- Включение и отключение нагревателя.
- Задание температуры нагрева и скорости вентилятора 1–6.
- Чтение температуры входящего воздуха, наличия нагревателя и маски ошибок.
- Опрос, последовательная очередь команд и автоматическое переподключение.

Протокол восстановлен по приложению Tion Remote. Тесты используют пакеты и имитацию
HCI/Noble; работа на физическом бризере пока не подтверждена. Только BR_LITE: общий UUID
с другими Tion не означает совместимость команд. OTA и сброс фильтра не реализованы.

## Способ взаимодействия: как в ioBroker.ble

Проанализирован [ioBroker.ble](https://github.com/AlCalzone/ioBroker.ble/tree/f0dd1214a8482b2d60cbf48f642e2add12ece177),
версия 0.14.1, commit `f0dd1214a8482b2d60cbf48f642e2add12ece177`:

- [scanProcess.ts](https://github.com/AlCalzone/ioBroker.ble/blob/f0dd1214a8482b2d60cbf48f642e2add12ece177/src/scanProcess.ts)
  загружает `@stoprocent/noble` после установки `NOBLE_HCI_DEVICE_ID`; поддерживает
  singleton и старый factory export с `{ extended: false }`.
- [main.ts](https://github.com/AlCalzone/ioBroker.ble/blob/f0dd1214a8482b2d60cbf48f642e2add12ece177/src/main.ts)
  запускает сканер через `child_process.fork()` и получает события через IPC.
- Native Bluetooth изолирован от процесса адаптера. В нашем драйвере при падении
  worker закрывается сессия, отменяются текущие команды и применяется существующий
  reconnect с задержкой. Старые команды после рестарта не повторяются.

Тот же подход реализован для BR_LITE: стандартный Linux HCI **RAW** backend Noble,
без `userChannel:true`. В worker входят scan, connect, GATT discovery, notifications
и ATT write. Parent содержит codec, очередь BR_LITE и ioBroker states. Сам ioBroker.ble
обрабатывает advertisements и пока не реализует GATT управление; поэтому его TCP
server для beacon scanning нельзя напрямую использовать для команд бризеру.

Зависимость `@stoprocent/noble` сохранена в версии ^2.8.0 текущего каркаса; подход
загрузки совместим с singleton/factory API. Обязательная dependency на
`@stoprocent/bluetooth-hci-socket` обеспечивает установку Linux HCI backend.

## Linux-контейнер

Нужен Bluetooth-контроллер, зарегистрированный ядром хоста как `hci0`, `hci1` и т.д.
D-Bus сокет не используется. В отличие от версии 0.0.2 с exclusive user channel,
контроллер перед запуском должен быть **up**, а не down.

### Подготовка хоста

```sh
hciconfig -a
# Подставьте фактический контроллер.
sudo hciconfig hci0 up
rfkill list bluetooth
```

Linux-драйвер должен распознавать USB-донгл (`btusb` для обычных устройств).
Не выгружайте `btusb`. Не запускайте параллельно другой сканер/клиент на том же HCI:
команды сканирования и соединений могут конфликтовать даже при RAW access.
Выделенный донгл удобен, но монопольный user channel больше не требуется.

### Docker Compose

Добавьте в существующий сервис ioBroker:

```yaml
services:
  iobroker:
    # Сохраните текущие image и volumes.
    network_mode: host
    cap_add:
      - NET_RAW
```

Прямой HCI использует ядро Linux, поэтому одного проброса `/dev/bus/usb/...` недостаточно.
Для этого RAW backend не нужен libusb USB mapping. При host networking секция `ports`
не используется, порты ioBroker становятся портами хоста. Пересоздайте контейнер.

Право создавать raw socket нужно фактическому процессу Node.js. Если он работает
от непривилегированного пользователя, `cap_add` может быть недостаточно после
снижения привилегий в entrypoint. Как описано в ioBroker.ble, задайте file capability
реальному Node binary **внутри контейнера**, от root:

```sh
setcap cap_net_raw+eip "$(readlink -f "$(command -v node)")"
getcap "$(readlink -f "$(command -v node)")"
```

Для `setcap/getcap` нужен `libcap2-bin`. После замены Node.js/образа настройку нужно
повторить. Rootless Docker и `no-new-privileges` могут препятствовать получению
capability. `privileged:true` не является обязательной настройкой этого драйвера.
`NOBLE_HCI_DEVICE_ID` задаётся worker из параметра `hci`; глобально задавать его не
нужно. `HCI_CHANNEL_USER` удаляется из окружения worker, чтобы остаться в RAW режиме.

Включите режим подключения на бризере согласно его инструкции и задайте MAC в Admin.
Noble HCI не использует bonding-ключи BlueZ. Для устройства, требующего BLE encryption,
потребуется отдельно проверить pairing; этот драйвер его автоматически не выполняет.

## Сборка и установка

Node.js >=20. В папке проекта:

```sh
npm ci
npm run check
npm test
npm run build
npm pack
```

Native HCI backend включён в обязательные зависимости. Для установки нужны
Linux-совместимые native binaries; при отсутствии prebuild потребуются Python 3,
make, g++, libbluetooth-dev и libudev-dev. Не используйте `--ignore-scripts` при
установке на целевой машине.
Сборка включает dev dependencies; не используйте `--omit=dev` до сборки.

Полученный архив `iobroker.tion_lite-0.0.3.tgz` перенесите в контейнер. Из каталога
установки ioBroker (обычно `/opt/iobroker`) установите локальный архив:

```sh
npm install /tmp/iobroker.tion_lite-0.0.3.tgz --omit=dev
iobroker add tion_lite
```

Затем задайте параметры экземпляра в Admin и перезапустите его. Не запускайте
`build/main.js` как самостоятельный сервис вне установленной среды ioBroker.

## Настройки экземпляра

| Параметр | По умолчанию | Назначение |
|---|---|---|
| address | пусто | MAC BR_LITE; обязателен |
| hci | hci0 | Выделенный USB HCI-контроллер, например hci1 |
| pollInterval | 5 | Интервал опроса, секунды, 5–3600 |
| responseTimeout | 3000 | Таймаут ответа бризера, миллисекунды, 1000–10000 |
| maxTemperature | 25 | Максимальная задаваемая температура: 25 либо 30 °C |

Диапазон температуры в приложении зависит от локали. 25 °C — консервативный предел;
30 °C включайте после проверки поддержки вашим устройством. Нулевое значение
температуры допустимо; состояние нагревателя задаётся отдельным переключателем.

## States

Все ID ниже относительны `tion_lite.0` (номер экземпляра может отличаться).

| State | Тип / доступ | Значение |
|---|---|---|
| info.driverState | string / R | Noble state: unknown, poweredOn, poweredOff, unauthorized, unsupported, disconnected |
| info.connection | boolean / R | Устройство подключено, информация и состояние прочитаны |
| info.address / info.name / info.model | string / R | Адрес, имя и настроенная модель BR_LITE |
| info.firmwareVersion | number / R | Сырые 16 бит версии прошивки |
| info.firmwareHex | string / R | Та же версия в hex, например 1234 |
| info.lastSeen | number / R | Время последнего валидного состояния, Unix ms |
| control.power | boolean / RW | Включение бризера |
| control.heaterEnabled | boolean / RW | Разрешение нагрева |
| control.targetTemperature | number / RW | Целевая температура, целое 0–25/30 °C |
| control.fanSpeed | number / RW | Скорость, целое 1–6 |
| sensors.inputTemperature | number / R | Температура входящего воздуха, °C |
| sensors.heaterPresent | boolean / R | Наличие нагревателя |
| diagnostics.errorMask | number / R | Неизменённая маска ошибок и предупреждений |
| diagnostics.lastError | string / R | Последняя ошибка обмена или команды |
| diagnostics.commandStatus | string / R | idle, pending, confirmed, failed |
| commands.refresh | boolean / W | Запись true вызывает чтение, затем кнопка сбрасывается |

Команды записываются с `ack:false`, подтверждённые показания публикуются с `ack:true`.
Выключение выполняется через `control.power=false`; fanSpeed=0 не является командой
выключения. Нагреватель и питание независимы: включение нагревателя само по себе
не включает бризер. `heaterEnabled` не показывает фактическую текущую мощность нагрева.

Перед каждой записью драйвер читает свежую конфигурацию, сохраняет пресеты,
звуковую и световую индикацию. После SET ждёт 1.5 с и читает состояние повторно;
`confirmed` выставляется только при совпадении изменённых полей. Завершение GATT
записи не считается подтверждением. При ошибке отправленная команда не повторяется
автоматически; драйвер переподключается и заново получает состояние.

Из-за неоднозначного расположения ID в декомпилированном приложении используется
одна ожидающая команда и проверка opcode/readback. Строгая корреляция всех ID требует
захвата реального обмена; задержанный ответ может влиять на эту проверку. CRC и длина
входящих сообщений проверяются, повреждённые сообщения отбрасываются.

## Диагностика

- `info.connection=false`: проверьте address/hci, режим подключения бризера,
  доступ к HCI в контейнере и `diagnostics.lastError`.
- `unsupported`/`unauthorized`: проверьте `network_mode: host`, capabilities Node.js,
  наличие выбранного `hciX` и состояние **up** до запуска адаптера; см. `info.driverState`.
- `EAFNOSUPPORT`: контейнер должен использовать `network_mode: host`.
- `Bluetooth worker exited`: native процесс упал; диагностика в `lastError`, worker
  будет создан заново с новой сессией, основной ioBroker продолжает работу.
- Ошибка native addon: установите зависимости на целевой Linux/архитектуре;
  не переносите node_modules с macOS или другой архитектуры.
- `HCI operation timed out`: проверьте USB-донгл, radio/rfkill, MAC и отсутствие
  другого процесса, который одновременно управляет контроллером.
- `Response timeout`: устройство занято другим клиентом, ошибочная модель, слабый
  сигнал либо неподтверждённая особенность протокола.
- `Discarded BLE packet` при debug: неверные фрагменты, длина или CRC; нужен захват
  обмена для сравнения с протоколом.
- `did not confirm`: фактическое значение отличается от заданного; команда
  не выдаётся за успешную.

## Разработка

- `src/lib/protocol.ts`: команды, CRC, фрагментация и парсеры.
- `src/lib/hci.ts`: Noble HCI RAW, scan/connect/notifications; загружается только worker.
- `src/hciWorker.ts`: дочерний процесс и последовательный обработчик GATT операций.
- `src/lib/workerTransport.ts`: parent proxy, IPC, таймауты и остановка worker.
- `src/lib/hciIpc.ts`: проверяемые типы сообщений IPC.
- `src/lib/transport.ts`: общий контракт BLE транспорта.
- `src/lib/session.ts`: очередь, таймауты и readback.
- `src/main.ts`: конфигурация, states и reconnect.
- `npm run test:ts`: codec, сессия, HCI/Noble, загрузка backend, IPC и падение worker.
- `npm run test:package`: проверки структуры пакета ioBroker.
- `npm run lint`, `npm run check`, `npm run build`: статические проверки и сборка.

API транспорта: [Noble](https://github.com/stoprocent/noble),
[native HCI socket](https://github.com/stoprocent/node-bluetooth-hci-socket).

## Changelog

### 0.0.3

* (DimiDr0l) Use ioBroker.ble-style Noble loading, standard HCI RAW access and an isolated Bluetooth worker with IPC and driver-state diagnostics.

### 0.0.2

* (DimiDr0l) Replace host D-Bus transport with direct native HCI access to a dedicated USB Bluetooth controller.

### 0.0.1

* (DimiDr0l) Implement BR_LITE device information, power, heater, temperature and fan controls through host BlueZ.

## License
MIT License

Copyright (c) 2026 DimiDr0l <dimidr@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.