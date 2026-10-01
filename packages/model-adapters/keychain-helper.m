#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef AW_KEYCHAIN_SERVICE
#define AW_KEYCHAIN_SERVICE "com.agent-workspaces.openai"
#endif
#define KEY_LIMIT 1024
static const char *account = "owner";
static int profile_key = 0;

static void erase(void *data, size_t size) { volatile unsigned char *p = data; while (size--) *p++ = 0; }
static int valid_key(const unsigned char *key, size_t size) {
  if (profile_key) { if (size < 8 || size > KEY_LIMIT) return 0; for (size_t i = 0; i < size; i++) if (key[i] < 33 || key[i] > 126) return 0; return 1; }
  if (size < 19 || size > 515 || memcmp(key, "sk-", 3)) return 0;
  for (size_t i = 3; i < size; i++) if (!((key[i] >= 'a' && key[i] <= 'z') || (key[i] >= 'A' && key[i] <= 'Z') || (key[i] >= '0' && key[i] <= '9') || key[i] == '_' || key[i] == '-')) return 0;
  return 1;
}
static CFMutableDictionaryRef query(void) {
  CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(q, kSecAttrService, profile_key ? CFSTR(AW_KEYCHAIN_SERVICE ".profiles") : CFSTR(AW_KEYCHAIN_SERVICE));
  CFStringRef name = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(q, kSecAttrAccount, name); CFRelease(name);
  CFDictionarySetValue(q, kSecAttrSynchronizable, kCFBooleanFalse);
  return q;
}
static OSStatus read_key(CFDataRef *result) {
  CFMutableDictionaryRef q = query();
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  OSStatus status = SecItemCopyMatching(q, (CFTypeRef *)result); CFRelease(q); return status;
}
static int fail(const char *code) { fprintf(stderr, "%s\n", code); return 1; }

static int keychain_main(int argc, const char **argv) {
  if (argc != 2 && argc != 3) return fail("Use status, read, set-stdin, or delete; never put a key in arguments.");
  if (argc == 3) {
    if (strlen(argv[2]) != 73 || strncmp(argv[2], "provider-", 9)) return fail("keychain_account_invalid");
    for (size_t i = 9; i < 73; i++) if (!((argv[2][i] >= '0' && argv[2][i] <= '9') || (argv[2][i] >= 'a' && argv[2][i] <= 'f'))) return fail("keychain_account_invalid");
    account = argv[2]; profile_key = 1;
  }
  if (!strcmp(argv[1], "status")) {
    CFMutableDictionaryRef q = query();
    CFDictionarySetValue(q, kSecReturnAttributes, kCFBooleanTrue);
    CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
    LAContext *context = [[LAContext alloc] init];
    context.interactionNotAllowed = YES;
    CFDictionarySetValue(q, kSecUseAuthenticationContext, (__bridge CFTypeRef)context);
    CFTypeRef result = NULL; OSStatus status = SecItemCopyMatching(q, &result);
    if (result) CFRelease(result); CFRelease(q);
    if (status == errSecSuccess) { puts("configured"); return 0; }
    if (status == errSecItemNotFound) { puts("missing"); return 0; }
    return fail("keychain_unavailable");
  }
  if (!strcmp(argv[1], "read")) {
    CFDataRef value = NULL; OSStatus status = read_key(&value);
    if (status != errSecSuccess || !value) return fail("keychain_key_unavailable");
    const unsigned char *bytes = CFDataGetBytePtr(value); size_t size = (size_t)CFDataGetLength(value);
    if (!valid_key(bytes, size)) { CFRelease(value); return fail("keychain_key_invalid"); }
    int okay = fwrite(bytes, 1, size, stdout) == size; CFRelease(value);
    return okay ? 0 : fail("keychain_pipe_failed");
  }
  if (!strcmp(argv[1], "set-stdin")) {
    if (isatty(STDIN_FILENO)) return fail("set-stdin requires a private pipe; interactive typing would echo the key.");
    unsigned char key[KEY_LIMIT + 3]; size_t size = fread(key, 1, sizeof key, stdin);
    if (ferror(stdin) || size == sizeof key || !feof(stdin)) { erase(key, sizeof key); return fail("key_invalid"); }
    if (size && key[size - 1] == '\n') size--;
    if (size && key[size - 1] == '\r') size--;
    if (!valid_key(key, size)) { erase(key, sizeof key); return fail("key_invalid"); }
    CFDataRef value = CFDataCreate(NULL, key, (CFIndex)size);
    CFMutableDictionaryRef q = query();
    CFMutableDictionaryRef update = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(update, kSecValueData, value);
    OSStatus status = SecItemUpdate(q, update);
    if (status == errSecItemNotFound) { CFDictionarySetValue(q, kSecValueData, value); status = SecItemAdd(q, NULL); }
    CFRelease(update); CFRelease(q); CFRelease(value);
    if (status != errSecSuccess) { erase(key, sizeof key); return fail("keychain_save_failed"); }
    CFDataRef verified = NULL; status = read_key(&verified);
    unsigned char difference = 0;
    if (status != errSecSuccess || !verified || (size_t)CFDataGetLength(verified) != size) difference = 1;
    else for (size_t i = 0; i < size; i++) difference |= key[i] ^ CFDataGetBytePtr(verified)[i];
    if (verified) CFRelease(verified); erase(key, sizeof key);
    if (difference) return fail("keychain_verification_failed");
    puts("saved"); return 0;
  }
  if (!strcmp(argv[1], "delete")) {
    CFMutableDictionaryRef q = query(); OSStatus status = SecItemDelete(q); CFRelease(q);
    if (status != errSecSuccess && status != errSecItemNotFound) return fail("keychain_delete_failed");
    puts("deleted"); return 0;
  }
  return fail("keychain_command_invalid");
}

int main(int argc, const char **argv) { @autoreleasepool { return keychain_main(argc, argv); } }
