/**
 * Companion Apex class for @uniferr/plugin-apex.
 * Receives serialised UnifErrEvent payloads from LWC and persists them.
 *
 * Deploy alongside the LWC and reference it from `apexPlugin({ invoke })`.
 */
public with sharing class UnifErrLogger {
    @AuraEnabled
    public static void log(String payload) {
        if (String.isBlank(payload)) {
            return;
        }
        UnifErr_Event__c record = new UnifErr_Event__c(
            Payload__c = payload,
            Captured_At__c = System.now()
        );
        insert record;
    }
}
